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

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

function Select-Session {
    try {
        $current = $manager.GetCurrentSession()
        $sessions = @($manager.GetSessions())
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

function Emit-State {
    try {
        $session = Select-Session
        if ($null -eq $session) {
            return (@{ active = $false } | ConvertTo-Json -Compress)
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
            'Paused' { $status = 'paused' }
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
        return (@{
            active = $true
            title = $props.Title
            artist = $props.Artist
            album = $props.AlbumTitle
            app = $session.SourceAppUserModelId
            status = $status
            position = [math]::Round($position, 2)
            duration = [math]::Round($duration, 2)
            art = $script:lastArt
        } | ConvertTo-Json -Compress)
    } catch {
        return (@{ active = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress)
    }
}

$script:lastArtKey = ''
$script:lastArt = ''
$lastPayload = ''

while ($true) {
    if (Test-Path -LiteralPath $CommandFile) {
        try {
            $command = Get-Content -LiteralPath $CommandFile -Raw -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $CommandFile -Force -ErrorAction SilentlyContinue
            if ($command) {
                Invoke-PlayerCommand ($command.Trim())
                $lastPayload = ''
            }
        } catch {
            # malformed command, ignore
        }
    }

    $payload = Emit-State
    if ($payload -ne $lastPayload) {
        [Console]::Out.WriteLine($payload)
        [Console]::Out.Flush()
        $lastPayload = $payload
    }
    Start-Sleep -Milliseconds 700
}
