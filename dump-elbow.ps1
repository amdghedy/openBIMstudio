$p1 = ".\src\modules\drawings\plan-generator.ts"
$p2 = ".\src\features\plan-view-panel.ts"
Write-Host "=== FITTING CASE (plan-generator.ts) ==="
$lines = Get-Content $p1
$start = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match 'case "fitting":') { $start = $i; break }
}
if ($start -ge 0) {
  for ($i = $start; $i -lt [Math]::Min($start + 95, $lines.Count); $i++) {
    Write-Host ("L{0}: {1}" -f ($i + 1), $lines[$i])
  }
}
Write-Host ""
Write-Host "=== ARC RENDER (plan-view-panel.ts) ==="
$lines2 = Get-Content $p2
$start2 = -1
for ($i = 0; $i -lt $lines2.Count; $i++) {
  if ($lines2[$i] -match 'door swings.*MEP') { $start2 = $i; break }
}
if ($start2 -ge 0) {
  for ($i = $start2; $i -lt [Math]::Min($start2 + 40, $lines2.Count); $i++) {
    Write-Host ("L{0}: {1}" -f ($i + 1), $lines2[$i])
  }
}