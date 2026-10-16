$SourceDir = "D:\Automation\000-Open BIM Studio\00-OpenBIMStudio"
$OutputDir = "D:\Automation\000-Open BIM Studio\00-OpenBIMStudio\OpenBIMStudio_Parts"
$MaxCharsPerPart = 250000 # Increased to minimize parts (~60k tokens)

if (!(Test-Path $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir | Out-Null }

# 1. Exclude heavy folders AND binary/non-code file extensions
$ExcludeFolders = @('node_modules', 'dist', '.git')
$ExcludeFiles = @('*.png', '*.jpg', '*.jpeg', '*.gif', '*.svg', '*.ico', '*.woff', '*.woff2', '*.ttf', '*.eot', '*.mp4', '*.pdf', '*.zip', '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml')

$Files = Get-ChildItem -Path $SourceDir -Recurse -File | Where-Object { 
    $path = $_.FullName
    $isExcludedFolder = $ExcludeFolders | Where-Object { $path -match $_ }
    $isExcludedFile = $ExcludeFiles | Where-Object { $path -like $_ }
    -not $isExcludedFolder -and -not $isExcludedFile
}

$PartNumber = 1
$CurrentChars = 0
$CurrentContent = ""

foreach ($File in $Files) {
    $RelativePath = $File.FullName.Replace($SourceDir, "")
    # Read file as raw text
    $FileContent = Get-Content $File.FullName -Raw -ErrorAction SilentlyContinue
    
    if ($null -eq $FileContent -or $FileContent.Length -eq 0) { continue } 

    $Block = "`n--- FILE: $RelativePath ---`n$FileContent`n--- END FILE ---`n"
    $BlockLength = $Block.Length

    if (($CurrentChars + $BlockLength) -gt $MaxCharsPerPart) {
        $OutFile = Join-Path $OutputDir "Project_Part_$PartNumber.txt"
        $CurrentContent | Out-File -FilePath $OutFile -Encoding utf8
        Write-Host "Created $OutFile"
        $PartNumber++
        $CurrentChars = 0
        $CurrentContent = ""
    }

    $CurrentContent += $Block
    $CurrentChars += $BlockLength
}

if ($CurrentChars -gt 0) {
    $OutFile = Join-Path $OutputDir "Project_Part_$PartNumber.txt"
    $CurrentContent | Out-File -FilePath $OutFile -Encoding utf8
    Write-Host "Created $OutFile"
}

Write-Host "Success! Minimized into $PartNumber parts."