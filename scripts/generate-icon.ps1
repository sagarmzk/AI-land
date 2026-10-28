$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\assets'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$outDir = (Resolve-Path $outDir).Path

function New-RoundedPath([System.Drawing.RectangleF]$rect, [float]$radius) {
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $d = $radius * 2
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconBitmap([int]$size) {
    $bmp = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $u = $size / 1024.0
    $cx = 512 * $u
    $cy = 512 * $u

    $rect = [System.Drawing.RectangleF]::new(26 * $u, 26 * $u, 972 * $u, 972 * $u)
    $path = New-RoundedPath $rect (224 * $u)
    $bg = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 22, 22, 22),
        [System.Drawing.Color]::FromArgb(255, 0, 0, 0),
        62.0
    )
    $g.FillPath($bg, $path)
    $bg.Dispose()

    $border = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(46, 255, 255, 255), [Math]::Max(1, 3 * $u))
    $g.DrawPath($border, $path)
    $border.Dispose()

    $glowPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $glowRadius = 430 * $u
    $glowPath.AddEllipse($cx - $glowRadius, $cy - $glowRadius, $glowRadius * 2, $glowRadius * 2)
    $glowBrush = [System.Drawing.Drawing2D.PathGradientBrush]::new($glowPath)
    $glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(34, 255, 255, 255)
    $glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
    $g.FillPath($glowBrush, $glowPath)
    $glowBrush.Dispose()
    $glowPath.Dispose()

    $innerGlowPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $innerGlowRadius = 250 * $u
    $innerGlowPath.AddEllipse($cx - $innerGlowRadius, $cy - $innerGlowRadius, $innerGlowRadius * 2, $innerGlowRadius * 2)
    $innerGlowBrush = [System.Drawing.Drawing2D.PathGradientBrush]::new($innerGlowPath)
    $innerGlowBrush.CenterColor = [System.Drawing.Color]::FromArgb(26, 255, 255, 255)
    $innerGlowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
    $g.FillPath($innerGlowBrush, $innerGlowPath)
    $innerGlowBrush.Dispose()
    $innerGlowPath.Dispose()

    $outer = 214 * $u
    $inner = 150 * $u
    $ringRect = [System.Drawing.RectangleF]::new(($cx - $outer), ($cy - $outer), ($outer * 2), ($outer * 2))
    $grad = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        $ringRect,
        [System.Drawing.Color]::FromArgb(255, 255, 255, 255),
        [System.Drawing.Color]::FromArgb(255, 122, 122, 119),
        35.0
    )
    $blend = [System.Drawing.Drawing2D.ColorBlend]::new(4)
    $blend.Colors = @(
        [System.Drawing.Color]::FromArgb(255, 255, 255, 255),
        [System.Drawing.Color]::FromArgb(255, 218, 218, 215),
        [System.Drawing.Color]::FromArgb(255, 138, 138, 135),
        [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
    )
    $blend.Positions = @(0.0, 0.38, 0.68, 1.0)
    $grad.InterpolationColors = $blend
    $g.FillEllipse($grad, $ringRect)
    $grad.Dispose()

    $holeBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 5, 5, 5))
    $g.FillEllipse($holeBrush, $cx - $inner, $cy - $inner, $inner * 2, $inner * 2)
    $holeBrush.Dispose()

    $holeEdge = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(70, 255, 255, 255), [Math]::Max(1, 3 * $u))
    $g.DrawEllipse($holeEdge, $cx - $inner, $cy - $inner, $inner * 2, $inner * 2)
    $holeEdge.Dispose()

    if ($size -ge 48) {
        $spec = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(150, 255, 255, 255), [Math]::Max(1, 16 * $u))
        $spec.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $spec.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $sr = 182 * $u
        $g.DrawArc($spec, $cx - $sr, $cy - $sr, $sr * 2, $sr * 2, 196, 54)
        $spec.Dispose()

        $coreGlow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(40, 255, 255, 255))
        $g.FillEllipse($coreGlow, $cx - 46 * $u, $cy - 46 * $u, 92 * $u, 92 * $u)
        $coreGlow.Dispose()
    }

    $g.Dispose()
    return $bmp
}

$pngSizes = @(16, 32, 48, 64, 128, 256, 512, 1024)
$pngPaths = @{}
foreach ($size in $pngSizes) {
    $bmp = New-IconBitmap $size
    $file = Join-Path $outDir ("icon-" + $size + ".png")
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $pngPaths[$size] = $file
}

$iconBmp = New-IconBitmap 512
$iconBmp.Save((Join-Path $outDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$iconBmp.Dispose()

$trayBmp = New-IconBitmap 32
$trayBmp.Save((Join-Path $outDir 'tray.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$trayBmp.Dispose()

$icoSizes = @(16, 24, 32, 48, 64, 128, 256)
foreach ($size in $icoSizes) {
    if (-not $pngPaths.ContainsKey($size)) {
        $bmp = New-IconBitmap $size
        $file = Join-Path $outDir ("icon-" + $size + ".png")
        $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $pngPaths[$size] = $file
    }
}

$icoPath = Join-Path $outDir 'icon.ico'
$stream = [System.IO.File]::Create($icoPath)
$writer = [System.IO.BinaryWriter]::new($stream)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$icoSizes.Count)
$offset = 6 + 16 * $icoSizes.Count
$blobs = @()
foreach ($size in $icoSizes) {
    $bytes = [System.IO.File]::ReadAllBytes($pngPaths[$size])
    $blobs += , @{ size = $size; bytes = $bytes; offset = $offset }
    $offset += $bytes.Length
}
foreach ($entry in $blobs) {
    $dim = if ($entry.size -ge 256) { 0 } else { $entry.size }
    $writer.Write([Byte]$dim)
    $writer.Write([Byte]$dim)
    $writer.Write([Byte]0)
    $writer.Write([Byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$entry.bytes.Length)
    $writer.Write([UInt32]$entry.offset)
}
foreach ($entry in $blobs) { $writer.Write($entry.bytes) }
$writer.Flush()
$writer.Close()
$stream.Close()

Get-ChildItem $outDir | Select-Object Name, Length | Format-Table -AutoSize
