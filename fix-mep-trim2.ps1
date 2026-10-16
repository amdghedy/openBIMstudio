Set-Location "D:\Automation\000-Open BIM Studio\00-OpenBIMStudio"
$p = ".\src\modules\drawings\plan-generator.ts"
$bak = "$p.bak-trim2-" + (Get-Date -Format yyyyMMdd-HHmmss)
Copy-Item $p $bak
Write-Host "Backup: $bak"

$b = [IO.File]::ReadAllBytes($p)
$o = 0
if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) { $o = 3 }
$text = [Text.Encoding]::UTF8.GetString($b, $o, $b.Length - $o)

# --- Fix 1: tighten tolerance ---
$oldTol = 'const tol = Math.max(0.30, w * 4);'
$newTol = 'const tol = Math.max(0.10, w * 0.6);'
if ($text.Contains($oldTol)) {
    $text = $text.Replace($oldTol, $newTol)
    Write-Host "Fix 1 OK: tolerance tightened"
} else {
    Write-Host "Fix 1 MISS: tolerance line not found"
}

# --- Fix 2: tan = bendRadius only (matches arc radius) ---
$oldTanA = 'const tanA = fitA ? Math.max(w, Number(fitA.params.bendRadius) || 0) : 0;'
$newTanA = 'const tanA = fitA ? Math.max(w, Number(fitA.params.bendRadius) || 0) - Math.hypot(ax - (fitA.params.point ? fitA.params.point[0] : ax), az - (fitA.params.point ? fitA.params.point[1] : az)) : 0;'
$oldTanB = 'const tanB = fitB ? Math.max(w, Number(fitB.params.bendRadius) || 0) : 0;'
$newTanB = 'const tanB = fitB ? Math.max(w, Number(fitB.params.bendRadius) || 0) - Math.hypot(bx - (fitB.params.point ? fitB.params.point[0] : bx), bz - (fitB.params.point ? fitB.params.point[1] : bz)) : 0;'

if ($text.Contains($oldTanA) -and $text.Contains($oldTanB)) {
    $text = $text.Replace($oldTanA, $newTanA)
    $text = $text.Replace($oldTanB, $newTanB)
    Write-Host "Fix 2 OK: trim amount corrected (offset to tangent point)"
} else {
    Write-Host "Fix 2 MISS: tan lines not found"
}

[IO.File]::WriteAllText($p, $text, (New-Object Text.UTF8Encoding $false))

Write-Host ""
Write-Host "--- Verify ---"
Select-String -Path $p -Pattern 'const tol = Math.max' | ForEach-Object { Write-Host "  L$($_.LineNumber): $($_.Line.Trim())" }
Select-String -Path $p -Pattern 'const tanA =' | ForEach-Object { Write-Host "  L$($_.LineNumber): $($_.Line.Trim().Substring(0, 60))" }
Select-String -Path $p -Pattern 'const tanB =' | ForEach-Object { Write-Host "  L$($_.LineNumber): $($_.Line.Trim().Substring(0, 60))" }

Write-Host ""
Write-Host "--- Typecheck ---"
npm run typecheck
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED - restoring"
    Copy-Item $bak $p -Force
    return
}
Write-Host "OK"