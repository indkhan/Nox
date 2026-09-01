Add-Type -AssemblyName System.Drawing
$output = Join-Path $PSScriptRoot '..\extension\public\icons'
New-Item -ItemType Directory -Force -Path $output | Out-Null

foreach ($size in 16, 32, 48, 128) {
  $bitmap = [Drawing.Bitmap]::new($size, $size)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([Drawing.Color]::FromArgb(37, 99, 235))
  $pen = [Drawing.Pen]::new([Drawing.Color]::White, [Math]::Max(1.5, $size * 0.065))
  $pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
  $points = [Drawing.PointF[]]@(
    [Drawing.PointF]::new($size * 0.5, $size * 0.19),
    [Drawing.PointF]::new($size * 0.77, $size * 0.345),
    [Drawing.PointF]::new($size * 0.77, $size * 0.655),
    [Drawing.PointF]::new($size * 0.5, $size * 0.81),
    [Drawing.PointF]::new($size * 0.23, $size * 0.655),
    [Drawing.PointF]::new($size * 0.23, $size * 0.345)
  )
  $graphics.DrawPolygon($pen, $points)
  $graphics.DrawEllipse($pen, $size * 0.41, $size * 0.41, $size * 0.18, $size * 0.18)
  $bitmap.Save((Join-Path $output "icon-$size.png"), [Drawing.Imaging.ImageFormat]::Png)
  $pen.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
