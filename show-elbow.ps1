$p = ".\src\modules\drawings\plan-generator.ts"
$lines = Get-Content $p
$start = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match 'if \(kind === "elbow"\)') { $start = $i; break }
}
if ($start -lt 0) { Write-Host "elbow block not found"; return }
for ($i = $start; $i -lt [Math]::Min($start + 60, $lines.Count); $i++) {
  Write-Host ("L{0}: {1}" -f ($i + 1), $lines[$i])
  if ($i -gt $start + 5 -and $lines[$i] -match '^\s*break;\s*$') { break }
}