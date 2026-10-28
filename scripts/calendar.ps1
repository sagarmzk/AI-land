$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    $outlook = New-Object -ComObject Outlook.Application
    $namespace = $outlook.GetNamespace('MAPI')
    $calendar = $namespace.GetDefaultFolder(9)
    $items = $calendar.Items
    $items.Sort('[Start]')
    $items.IncludeRecurrences = $true

    $now = Get-Date
    $found = $null
    $scanned = 0

    foreach ($item in $items) {
        $scanned++
        if ($scanned -gt 600) { break }
        try {
            if ($null -eq $item.Start) { continue }
            if ($item.End -lt $now) { continue }
            if ([string]::IsNullOrWhiteSpace([string]$item.Subject)) { continue }
            $found = $item
            break
        } catch {
            continue
        }
    }

    if ($found) {
        @{
            available = $true
            subject = [string]$found.Subject
            start = $found.Start.ToString('o')
            end = $found.End.ToString('o')
            location = [string]$found.Location
            allDay = [bool]$found.AllDayEvent
        } | ConvertTo-Json -Compress
    } else {
        @{ available = $true; none = $true } | ConvertTo-Json -Compress
    }
} catch {
    @{ available = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
