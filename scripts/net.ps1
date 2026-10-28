$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms

function Get-NetTotals {
    try {
        $stats = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
            Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
            ForEach-Object { $_.GetIPv4Statistics() }
        $rx = ($stats | Measure-Object -Property BytesReceived -Sum).Sum
        $tx = ($stats | Measure-Object -Property BytesSent -Sum).Sum
        if ($null -eq $rx) { $rx = 0 }
        if ($null -eq $tx) { $tx = 0 }
        return @([double]$rx, [double]$tx)
    } catch {
        return @(0.0, 0.0)
    }
}

while ($true) {
    $totals = Get-NetTotals
    $disk = $null
    try { $disk = [System.IO.DriveInfo]::new('C') } catch { }
    $battery = 255
    $charging = $false
    $hasBattery = $false
    try {
        $power = [System.Windows.Forms.SystemInformation]::PowerStatus
        $battery = [int]$power.BatteryLifePercent
        $charging = ($power.PowerLineStatus -eq [System.Windows.Forms.PowerLineStatus]::Online)
        $hasBattery = ($power.BatteryChargeStatus -ne [System.Windows.Forms.BatteryChargeStatus]::NoSystemBattery)
    } catch { }

    $payload = @{
        rx = $totals[0]
        tx = $totals[1]
        diskFree = if ($disk) { [double]$disk.AvailableFreeSpace } else { 0 }
        diskTotal = if ($disk) { [double]$disk.TotalSize } else { 0 }
        battery = $battery
        charging = $charging
        hasBattery = $hasBattery
    } | ConvertTo-Json -Compress

    [Console]::Out.WriteLine($payload)
    [Console]::Out.Flush()
    Start-Sleep -Seconds 2
}
