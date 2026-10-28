param(
    [string]$CommandFile = (Join-Path $env:TEMP 'ailand-cmd.txt')
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $netTask = $asTask.Invoke($null, @($op))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AilandNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct SYSTEM_POWER_STATUS
    {
        public byte ACLineStatus;
        public byte BatteryFlag;
        public byte BatteryLifePercent;
        public byte Reserved1;
        public int BatteryLifeTime;
        public int BatteryFullLifeTime;
    }

    [DllImport("kernel32.dll")]
    public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);

    [DllImport("psapi.dll")]
    public static extern bool EmptyWorkingSet(IntPtr process);
}
'@

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$script:manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$script:lastArtKey = ''
$script:lastArt = ''
$script:mediaActive = $false

function Select-Session {
    try {
        $current = $script:manager.GetCurrentSession()
        $sessions = @($script:manager.GetSessions())
        if ($sessions.Count -eq 0) { return $null }
        $playing = @($sessions | Where-Object {
            try { $_.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing' } catch { $false }
        })
        if ($playing.Count -gt 0) {
            if ($null -ne $current -and $playing -contains $current) { return $current }
            $best = $playing[0]
            $bestAt = [datetimeoffset]::MinValue
            foreach ($item in $playing) {
                try {
                    $at = $item.GetTimelineProperties().LastUpdatedTime
                    if ($at -gt $bestAt) { $bestAt = $at; $best = $item }
                } catch { }
            }
            return $best
        }
        if ($null -ne $current) { return $current }
        return $sessions[0]
    } catch {
        return $null
    }
}

function Get-ArtPath($session) {
    try {
        $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $ref = $props.Thumbnail
        if ($null -eq $ref) { return '' }
        $stream = Await ($ref.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $size = [uint32]$stream.Size
        if ($size -eq 0 -or $size -gt 8000000) { return '' }
        $reader = [Windows.Storage.Streams.DataReader]::new($stream)
        Await ($reader.LoadAsync($size)) ([uint32]) | Out-Null
        $bytes = New-Object byte[] $size
        $reader.ReadBytes($bytes)
        $reader.Dispose()
        $stream.Dispose()
        $ext = '.jpg'
        if ($props.ThumbnailContentType -like '*png*') { $ext = '.png' }
        $hash = [System.Security.Cryptography.SHA1]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($props.Title + '|' + $props.Artist))
        $name = -join ($hash | ForEach-Object { $_.ToString('x2') })
        $dir = Join-Path $env:TEMP 'ailand-art'
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        $path = Join-Path $dir ($name + $ext)
        if (-not (Test-Path $path)) { [System.IO.File]::WriteAllBytes($path, $bytes) }
        return $path
    } catch {
        return ''
    }
}

function Invoke-PlayerCommand($text) {
    try {
        $session = Select-Session
        if ($null -eq $session) { return }
        switch -Regex ($text) {
            '^toggle' { Await ($session.TryTogglePlayPauseAsync()) ([bool]) | Out-Null }
            '^next' { Await ($session.TrySkipNextAsync()) ([bool]) | Out-Null }
            '^previous' { Await ($session.TrySkipPreviousAsync()) ([bool]) | Out-Null }
            '^play' {
                if ($session.GetPlaybackInfo().PlaybackStatus.ToString() -ne 'Playing') {
                    Await ($session.TryPlayAsync()) ([bool]) | Out-Null
                }
            }
            '^pause' {
                if ($session.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing') {
                    Await ($session.TryPauseAsync()) ([bool]) | Out-Null
                }
            }
            '^seek:(\d+(?:\.\d+)?)' {
                $seconds = [double]$Matches[1]
                $ticks = [int64]($seconds * 10000000)
                Await ($session.TryChangePlaybackPositionAsync($ticks)) ([bool]) | Out-Null
            }
        }
    } catch {
        # player does not support the command
    }
}

function Build-MediaPayload {
    try {
        $session = Select-Session
        if ($null -eq $session) {
            $script:mediaActive = $false
            return [ordered]@{ k = 'media'; active = $false } | ConvertTo-Json -Compress
        }
        $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $info = $session.GetPlaybackInfo()
        $timeline = $session.GetTimelineProperties()
        $artKey = "$($props.Title)|$($props.Artist)|$($props.AlbumTitle)"
        if ($artKey -ne $script:lastArtKey) {
            $script:lastArt = Get-ArtPath $session
            $script:lastArtKey = $artKey
        }
        $status = 'paused'
        switch ($info.PlaybackStatus.ToString()) {
            'Playing' { $status = 'playing' }
            'Stopped' { $status = 'stopped' }
            'Changing' { $status = 'playing' }
        }
        $duration = 0.0
        $position = 0.0
        try {
            $duration = $timeline.EndTime.TotalSeconds - $timeline.StartTime.TotalSeconds
            $position = $timeline.Position.TotalSeconds - $timeline.StartTime.TotalSeconds
        } catch { }
        if ($position -lt 0) { $position = 0 }
        if ($duration -lt 0) { $duration = 0 }
        $script:mediaActive = $true
        return [ordered]@{
            k = 'media'
            active = $true
            title = $props.Title
            artist = $props.Artist
            album = $props.AlbumTitle
            app = $session.SourceAppUserModelId
            status = $status
            position = [math]::Round($position, 2)
            duration = [math]::Round($duration, 2)
            art = $script:lastArt
        } | ConvertTo-Json -Compress
    } catch {
        $script:mediaActive = $false
        return [ordered]@{ k = 'media'; active = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    }
}

function Get-NetTotals {
    $rx = [double]0
    $tx = [double]0
    try {
        foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
            if ($nic.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
            if ($nic.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) { continue }
            try {
                $stats = $nic.GetIPv4Statistics()
                $rx += $stats.BytesReceived
                $tx += $stats.BytesSent
            } catch { }
        }
    } catch { }
    return @($rx, $tx)
}

function Get-PowerState {
    try {
        $status = [AilandNative+SYSTEM_POWER_STATUS]::new()
        if ([AilandNative]::GetSystemPowerStatus([ref]$status)) {
            $percent = [int]$status.BatteryLifePercent
            if ($percent -gt 100) { $percent = -1 }
            return @{
                battery = $percent
                charging = ($status.ACLineStatus -eq 1)
                hasBattery = (($status.BatteryFlag -ne 128) -and ($percent -ge 0))
            }
        }
    } catch { }
    return @{ battery = -1; charging = $false; hasBattery = $false }
}

function Get-DiskInfo {
    try {
        $drive = [System.IO.DriveInfo]::new('C')
        return @([double]$drive.AvailableFreeSpace, [double]$drive.TotalSize)
    } catch {
        return @([double]0, [double]0)
    }
}

$lastMedia = ''
$lastSys = ''
$sinceMedia = 999
$sinceNet = 999
$sinceSlow = 0
$sinceTrim = 0
$mediaGap = 5
$netGap = 5
$slowGap = 25

while ($true) {
    if (Test-Path -LiteralPath $CommandFile) {
        try {
            $command = Get-Content -LiteralPath $CommandFile -Raw -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $CommandFile -Force -ErrorAction SilentlyContinue
            if ($command) {
                Invoke-PlayerCommand ($command.Trim())
                $lastMedia = ''
                $sinceMedia = 999
            }
        } catch {
            # malformed command, ignore
        }
    }

    if ($sinceMedia -ge $mediaGap) {
        $sinceMedia = 0
        $payload = Build-MediaPayload
        if ($payload -ne $lastMedia) {
            [Console]::Out.WriteLine($payload)
            [Console]::Out.Flush()
            $lastMedia = $payload
        }
        if ($script:mediaActive) { $mediaGap = 2 } else { $mediaGap = 5 }
    }

    if ($sinceNet -ge $netGap) {
        $sinceNet = 0
        $totals = Get-NetTotals
        $power = Get-PowerState
        $disk = Get-DiskInfo
        $sys = [ordered]@{
            k = 'sys'
            rx = $totals[0]
            tx = $totals[1]
            diskFree = $disk[0]
            diskTotal = $disk[1]
            battery = $power.battery
            charging = $power.charging
            hasBattery = $power.hasBattery
        } | ConvertTo-Json -Compress
        if ($sys -ne $lastSys) {
            [Console]::Out.WriteLine($sys)
            [Console]::Out.Flush()
            $lastSys = $sys
        }
    }

    if ($sinceSlow -ge $slowGap) {
        $sinceSlow = 0
        [System.GC]::Collect()
    }

    if ($sinceTrim -ge 150) {
        $sinceTrim = 0
        try {
            [AilandNative]::EmptyWorkingSet([System.Diagnostics.Process]::GetCurrentProcess().Handle) | Out-Null
        } catch { }
    }

    $sinceMedia++
    $sinceNet++
    $sinceSlow++
    $sinceTrim++
    Start-Sleep -Milliseconds 400
}
