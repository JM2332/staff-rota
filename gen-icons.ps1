Add-Type -AssemblyName System.Drawing

$forest = [System.Drawing.Color]::FromArgb(255, 0x1C, 0x3A, 0x2B)
$cream  = [System.Drawing.Color]::FromArgb(255, 0xF6, 0xF3, 0xE7)
$chartreuse = [System.Drawing.Color]::FromArgb(255, 0xCD, 0xDC, 0x5C)

function New-Icon([int]$size, [string]$outPath) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear($forest)

  # Safe zone ~66% of icon for maskable icons; clipboard sits centered within it.
  $boardW = $size * 0.44
  $boardH = $size * 0.62
  $bx = ($size - $boardW) / 2
  $by = ($size - $boardH) / 2 + $size * 0.02

  $creamBrush = New-Object System.Drawing.SolidBrush($cream)
  $g.FillRectangle($creamBrush, $bx, $by, $boardW, $boardH)

  $tabW = $boardW * 0.5
  $tabH = $boardH * 0.09
  $tx = $bx + ($boardW - $tabW) / 2
  $ty = $by - $tabH * 0.55
  $chartBrush = New-Object System.Drawing.SolidBrush($chartreuse)
  $g.FillRectangle($chartBrush, $tx, $ty, $tabW, $tabH)

  $pen = New-Object System.Drawing.Pen($forest, [Math]::Max(1.5, $size * 0.018))
  $lineInsetX = $boardW * 0.16
  $lineW = $boardW - ($lineInsetX * 2)
  $lineYs = @(0.32, 0.50, 0.65)
  foreach ($frac in $lineYs) {
    $ly = $by + $boardH * $frac
    $lw = if ($frac -eq 0.65) { $lineW * 0.6 } else { $lineW }
    $g.DrawLine($pen, $bx + $lineInsetX, $ly, $bx + $lineInsetX + $lw, $ly)
  }

  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

New-Icon 192 "$PSScriptRoot\icon-192.png"
New-Icon 512 "$PSScriptRoot\icon-512.png"
New-Icon 180 "$PSScriptRoot\apple-touch-icon.png"

Write-Host "Icons generated."
