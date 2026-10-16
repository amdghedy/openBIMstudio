<#
.SYNOPSIS
  Bundle an entire project (structure + source) into a few large files and push to GitHub.
#>

[CmdletBinding()]
param(
    [string]$OutputDir      = ".\_export",
    [int]   $MaxBundleMB    = 8,
    [switch]$Push,
    [string]$Branch         = "main",
    [string]$CommitMessage  = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

# ---------- Config ----------
$Root = (Get-Location).Path

$SkipDirs = @(
    ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt",
    ".cache", ".parcel-cache", "coverage", ".vscode", ".idea",
    "bin", "obj", ".vs", ".turbo", ".vercel", ".netlify",
    "vendor", "Pods", ".gradle", ".mvn", "__pycache__", ".pytest_cache",
    ".mypy_cache", "target", ".terraform", "_export"
)

$SourceExt = @(
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".json", ".jsonc", ".json5",
    ".css", ".scss", ".sass", ".less",
    ".html", ".htm", ".vue", ".svelte", ".astro",
    ".md", ".mdx", ".txt", ".yml", ".yaml", ".toml", ".ini", ".cfg",
    ".py", ".cs", ".cpp", ".cc", ".cxx", ".h", ".hpp",
    ".java", ".kt", ".kts", ".go", ".rs", ".rb", ".php",
    ".sh", ".ps1", ".psm1", ".psd1", ".bat", ".cmd",
    ".sql", ".graphql", ".gql", ".proto",
    ".svg", ".xml", ".plist", ".gradle", ".properties"
)

$AlwaysIncludeNames = @(
    "Dockerfile", "Makefile", "LICENSE", "README", "CHANGELOG",
    ".gitignore", ".gitattributes", ".editorconfig", ".npmrc",
    ".prettierrc", ".eslintrc", "Procfile"
)

# ---------- Helpers ----------
function Test-SkipPath {
    param([string]$FullPath)
    $rel = $FullPath.Substring($Root.Length).TrimStart('\','/')
    $parts = $rel -split '[\\/]'
    foreach ($p in $parts) {
        if ($SkipDirs -contains $p) { return $true }
    }
    return $false
}

function Get-RelPath {
    param([string]$FullPath)
    return $FullPath.Substring($Root.Length).TrimStart('\','/').Replace('\','/')
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

# ---------- Prep ----------
if (Test-Path $OutputDir) {
    Remove-Item $OutputDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputDir | Out-Null

$manifest = New-Object System.Collections.Generic.List[object]
$treeLines = New-Object System.Collections.Generic.List[string]

Write-Host "Scanning $Root ..." -ForegroundColor Cyan

# ---------- Collect files ----------
$allFiles = Get-ChildItem -Path $Root -Recurse -File -Force |
    Where-Object { -not (Test-SkipPath $_.FullName) }

$sourceFiles = @()
foreach ($f in $allFiles) {
    $ext = $f.Extension.ToLowerInvariant()
    $isSource = ($SourceExt -contains $ext) -or
                ($AlwaysIncludeNames -contains $f.Name) -or
                ($f.Name -like ".env*")
    if ($isSource) { $sourceFiles += $f }
}

$sourceFiles = $sourceFiles | Sort-Object FullName

Write-Host ("Found {0} files total; {1} source files." -f $allFiles.Count, $sourceFiles.Count) -ForegroundColor Green

# ---------- Build tree (ASCII-only) ----------
function Add-Tree {
    param([string]$Path, [string]$Prefix = "")
    $items = Get-ChildItem -Path $Path -Force |
        Sort-Object @{E={$_.PSIsContainer};Descending=$true}, Name
    for ($i = 0; $i -lt $items.Count; $i++) {
        $item = $items[$i]
        if (Test-SkipPath $item.FullName) { continue }
        $isLast = ($i -eq $items.Count - 1)
        if ($isLast) { $branch = "\-- " } else { $branch = "|-- " }
        $treeLines.Add("$Prefix$branch$($item.Name)")
        if ($item.PSIsContainer) {
            if ($isLast) { $newPrefix = $Prefix + "    " }
            else         { $newPrefix = $Prefix + "|   " }
            Add-Tree -Path $item.FullName -Prefix $newPrefix
        }
    }
}

$treeLines.Add((Split-Path $Root -Leaf) + "/")
Add-Tree -Path $Root

Write-Utf8NoBom -Path (Join-Path $OutputDir "structure.txt") -Content ($treeLines -join "`n")
Write-Host "Wrote structure.txt" -ForegroundColor Yellow

# ---------- Bundle source ----------
$maxBytes = $MaxBundleMB * 1MB
$bundleIndex = 0
$bundleBuffer = New-Object System.Text.StringBuilder
$bundleBytes = 0
$currentFiles = New-Object System.Collections.Generic.List[string]

function Flush-Bundle {
    if ($bundleBuffer.Length -eq 0) { return }
    $script:bundleIndex++
    $name = "bundle-{0:D3}.md" -f $script:bundleIndex
    $path = Join-Path $OutputDir $name
    $header = "# Bundle $($script:bundleIndex) - $($currentFiles.Count) files`n`n"
    Write-Utf8NoBom -Path $path -Content ($header + $bundleBuffer.ToString())
    Write-Host ("  wrote {0} ({1:N2} MB, {2} files)" -f $name, ($bundleBytes/1MB), $currentFiles.Count) -ForegroundColor DarkGray
    $script:bundleBuffer = New-Object System.Text.StringBuilder
    $script:bundleBytes = 0
    $script:currentFiles = New-Object System.Collections.Generic.List[string]
}

$globalFileIndex = 0
foreach ($f in $sourceFiles) {
    $rel = Get-RelPath $f.FullName

    try {
        $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    } catch {
        Write-Warning "Skip (unreadable): $rel"
        continue
    }

    $isBinary = $false
    $checkLen = [Math]::Min(8192, $bytes.Length)
    for ($i = 0; $i -lt $checkLen; $i++) {
        if ($bytes[$i] -eq 0) { $isBinary = $true; break }
    }
    if ($isBinary) {
        Write-Host "  skip binary: $rel" -ForegroundColor DarkYellow
        continue
    }

    $text = [System.Text.Encoding]::UTF8.GetString($bytes)

    $ext = $f.Extension.TrimStart('.').ToLowerInvariant()
    $lang = switch ($ext) {
        "ts"   { "ts" }   "tsx"  { "tsx" }  "js"   { "js" }
        "jsx"  { "jsx" }  "mjs"  { "js" }   "cjs"  { "js" }
        "json" { "json" } "jsonc"{ "jsonc" } "json5"{ "json5" }
        "css"  { "css" }  "scss" { "scss" } "less" { "less" }
        "html" { "html" } "md"   { "md" }   "yml"  { "yaml" }
        "yaml" { "yaml" } "toml" { "toml" } "py"   { "py" }
        "cs"   { "csharp" } "cpp" { "cpp" } "h"    { "cpp" }
        "hpp"  { "cpp" }  "java" { "java" } "kt"   { "kotlin" }
        "go"   { "go" }   "rs"   { "rust" } "rb"   { "ruby" }
        "php"  { "php" }  "sh"   { "sh" }   "ps1"  { "powershell" }
        "sql"  { "sql" }  "xml"  { "xml" }  "svg"  { "xml" }
        "gradle" { "groovy" } "properties" { "properties" }
        default { "" }
    }

    $sha = (Get-FileHash -Path $f.FullName -Algorithm SHA256).Hash
    $manifest.Add([pscustomobject]@{
        index    = $globalFileIndex++
        path     = $rel
        size     = $f.Length
        sha256   = $sha
        lang     = $lang
    }) | Out-Null

    $entry = "`n--- FILE: $rel ---`n" + '```' + "$lang`n$text`n" + '```' + "`n--- END FILE ---`n"
    $entryBytes = [System.Text.Encoding]::UTF8.GetByteCount($entry)

    if ($bundleBytes + $entryBytes -gt $maxBytes -and $bundleBuffer.Length -gt 0) {
        Flush-Bundle
    }

    [void]$bundleBuffer.Append($entry)
    $bundleBytes += $entryBytes
    $currentFiles.Add($rel) | Out-Null
}
Flush-Bundle

# ---------- Manifest ----------
$manifestObj = [pscustomobject]@{
    project    = (Split-Path $Root -Leaf)
    generated  = (Get-Date).ToString("o")
    root       = $Root
    totalFiles = $manifest.Count
    bundles    = $bundleIndex
    files      = $manifest
}
$json = $manifestObj | ConvertTo-Json -Depth 6
Write-Utf8NoBom -Path (Join-Path $OutputDir "manifest.json") -Content $json
Write-Host "Wrote manifest.json" -ForegroundColor Yellow

# ---------- .gitattributes ----------
$gitAttr = @"
* text=auto eol=lf
*.ps1 text eol=crlf
*.bat text eol=crlf
*.cmd text eol=crlf
*.md text eol=lf
"@
Write-Utf8NoBom -Path (Join-Path $OutputDir ".gitattributes") -Content $gitAttr

# ---------- README ----------
$readmeLines = @(
    "# OpenBIMStudio - Code Export",
    "",
    "Generated: $($manifestObj.generated)",
    "",
    "- structure.txt - full folder tree",
    "- manifest.json - every file: path, size, sha256, language",
    "- bundle-XXX.md - full source code, grouped to stay under GitHub preview limits",
    "",
    "Total files bundled: $($manifest.Count)",
    "Total bundles: $bundleIndex",
    "",
    "Each file inside a bundle is delimited by:",
    "",
    "    --- FILE: <relative/path> ---",
    '    ```<lang>',
    "    ...content...",
    '    ```',
    "    --- END FILE ---"
)
Write-Utf8NoBom -Path (Join-Path $OutputDir "README.md") -Content ($readmeLines -join "`n")

# ---------- Push ----------
if ($Push) {
    Write-Host "`n=== Pushing to GitHub ===" -ForegroundColor Cyan

    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { throw "git not found in PATH." }

    if (-not (Test-Path (Join-Path $Root ".git"))) {
        Write-Host "No .git found - initializing..." -ForegroundColor Yellow
        git init | Out-Host
        git branch -M $Branch | Out-Host
    }

    $remotes = git remote
    if ($remotes -notcontains "origin") {
        $url = Read-Host "No 'origin' remote. Enter GitHub URL (https://github.com/user/repo.git)"
        git remote add origin $url | Out-Host
    }

    if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
        $CommitMessage = "chore: add full code export ($($manifest.Count) files, $bundleIndex bundles)"
    }

    git add $OutputDir | Out-Host
    git status --short | Out-Host
    git commit -m $CommitMessage | Out-Host
    git push -u origin $Branch | Out-Host

    Write-Host "Pushed." -ForegroundColor Green
}

Write-Host "`nDone. Output: $OutputDir" -ForegroundColor Green
Write-Host "Next: open https://github.com/<you>/<repo>/tree/$Branch/$((Split-Path $OutputDir -Leaf))" -ForegroundColor Green