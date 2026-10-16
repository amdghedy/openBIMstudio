# Navisworks 2025 GLB Exporter - Build & Deploy

$ErrorActionPreference = "Stop"

$ProjectName       = "NavisworksGLBExporter"
$CompanyName       = "MYCOMPANY"
$NavisworksYear    = "2025"
$NavisworksSeries  = "Nw22"

$RootDir           = "D:\Automation\Open BIM Studio\OpenBIMStudio\NavisworksGLBExporter"
$SrcDir            = Join-Path $RootDir "src"
$BuildDir          = Join-Path $RootDir "build"
$BundleDir         = Join-Path $env:APPDATA "Autodesk\ApplicationPlugins\$ProjectName.bundle"
$BundleContentsDir = Join-Path $BundleDir "Contents\v$NavisworksSeries"

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " Navisworks 2025 GLB Exporter Setup" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

# ---------- STEP 1: Locate Navisworks DLLs ----------
Write-Host ""
Write-Host "[1/6] Locating Navisworks DLLs..." -ForegroundColor Yellow

$NavisworksDir = "C:\Program Files\Autodesk\Navisworks Manage $NavisworksYear"
if (-not (Test-Path $NavisworksDir)) {
    $NavisworksDir = "C:\Program Files\Autodesk\Navisworks Simulate $NavisworksYear"
}
if (-not (Test-Path $NavisworksDir)) {
    Write-Host "ERROR: Navisworks $NavisworksYear not found." -ForegroundColor Red
    exit 1
}
Write-Host "  Dir: $NavisworksDir" -ForegroundColor Green

$NwApiPath     = Join-Path $NavisworksDir "Autodesk.Navisworks.Api.dll"
$NwComApiPath  = Join-Path $NavisworksDir "Autodesk.Navisworks.ComApi.dll"
$NwInteropPath = Join-Path $NavisworksDir "Autodesk.Navisworks.Interop.ComApi.dll"
$AdWinPath     = Join-Path $NavisworksDir "AdWindows.dll"

foreach ($dll in @($NwApiPath, $NwComApiPath, $NwInteropPath, $AdWinPath)) {
    if (-not (Test-Path $dll)) {
        Write-Host "ERROR: Missing DLL: $dll" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Found: $(Split-Path $dll -Leaf)" -ForegroundColor Green
}

# Known assembly + namespace values (verified from earlier inspection)
$ApiAsmName     = "Autodesk.Navisworks.Api"
$ComApiAsmName  = "Autodesk.Navisworks.ComApi"
$InteropAsmName = "Autodesk.Navisworks.Interop.ComApi"
$AdWinAsmName   = "AdWindows"
$InteropNs      = "Autodesk.Navisworks.Api.Interop.ComApi"
$BridgeNs       = "Autodesk.Navisworks.Api.ComApi"

# ---------- STEP 2: Locate MSBuild ----------
Write-Host ""
Write-Host "[2/6] Locating MSBuild..." -ForegroundColor Yellow

$VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$MSBuild = $null
if (Test-Path $VsWhere) {
    $MSBuild = & $VsWhere -latest -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
}
if (-not $MSBuild -or -not (Test-Path $MSBuild)) {
    foreach ($f in @(
        "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe",
        "C:\Program Files\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\MSBuild.exe",
        "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\MSBuild.exe"
    )) { if (Test-Path $f) { $MSBuild = $f; break } }
}
if (-not $MSBuild) {
    Write-Host "ERROR: MSBuild not found." -ForegroundColor Red
    exit 1
}
Write-Host "  MSBuild: $MSBuild" -ForegroundColor Green

# ---------- STEP 3: Create directories ----------
Write-Host ""
Write-Host "[3/6] Creating directories..." -ForegroundColor Yellow

foreach ($d in @($RootDir, $SrcDir, $BuildDir, $BundleDir, $BundleContentsDir)) {
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
}
Write-Host "  Ready." -ForegroundColor Green

# ---------- STEP 4: Write C# source files ----------
Write-Host ""
Write-Host "[4/6] Writing source files..." -ForegroundColor Yellow

$PluginCs = @"
using System;
using System.Windows.Forms;
using Autodesk.Navisworks.Api;
using Autodesk.Navisworks.Api.Plugins;

namespace NavisworksGLBExporter
{
    [Plugin("GLBExporter", "MYCOMPANY", DisplayName = "GLB Exporter")]
    [AddInPlugin(AddInLocation.AddIn)]
    public class GLBExporterPlugin : AddInPlugin
    {
        public override int Execute(params string[] parameters)
        {
            Document doc = Autodesk.Navisworks.Api.Application.ActiveDocument;
            if (doc == null)
            {
                MessageBox.Show("No document open.", "GLB Exporter");
                return 1;
            }

            using (SaveFileDialog sfd = new SaveFileDialog())
            {
                sfd.Filter = "GLB File (*.glb)|*.glb";
                sfd.Title = "Save selection as GLB";
                sfd.FileName = "model.glb";
                if (sfd.ShowDialog() != DialogResult.OK) return 0;

                System.Windows.Forms.Cursor.Current = System.Windows.Forms.Cursors.WaitCursor;
                try
                {
                    new GLBModelExporter().Export(doc, sfd.FileName);
                    System.Windows.Forms.Cursor.Current = System.Windows.Forms.Cursors.Default;
                    MessageBox.Show("Export complete!\n\n" + sfd.FileName, "GLB Exporter");
                }
                catch (Exception ex)
                {
                    System.Windows.Forms.Cursor.Current = System.Windows.Forms.Cursors.Default;
                    MessageBox.Show("Export failed:\n\n" + ex.Message, "GLB Exporter");
                }
            }
            return 0;
        }
    }
}
"@

$ExporterCs = @"
using System;
using System.Collections.Generic;
using Autodesk.Navisworks.Api;
using ComApi = $InteropNs;
using ComBridge = $BridgeNs.ComApiBridge;

namespace NavisworksGLBExporter
{
    public class GLBModelExporter : ComApi.InwSimplePrimitivesCB
    {
        private readonly List<float> _positions = new List<float>();
        private readonly List<float> _normals   = new List<float>();
        private readonly List<uint>  _indices   = new List<uint>();
        private uint _vertexOffset = 0;

        public void Export(Document doc, string filePath)
        {
            _positions.Clear();
            _normals.Clear();
            _indices.Clear();
            _vertexOffset = 0;

            ModelItemCollection modelItems = doc.CurrentSelection.SelectedItems;

            if (modelItems == null || modelItems.Count == 0)
            {
                throw new Exception("Nothing is selected. Please select items first.");
            }

            ComApi.InwOpState10 oState = ComBridge.State;
            ComApi.InwOpSelection oSel = ComBridge.ToInwOpSelection(modelItems);

            foreach (ComApi.InwOaPath3 path in oSel.Paths())
            {
                foreach (ComApi.InwOaFragment3 frag in path.Fragments())
                {
                    frag.GenerateSimplePrimitives(ComApi.nwEVertexProperty.eNORMAL, this);
                }
            }

            if (_positions.Count == 0)
                throw new Exception("No geometry extracted from the selected items.");

            GLBWriter.Write(filePath, _positions, _normals, _indices);
        }

        public void Triangle(ComApi.InwSimpleVertex v1,
                             ComApi.InwSimpleVertex v2,
                             ComApi.InwSimpleVertex v3)
        {
            AddVertex(v1); AddVertex(v2); AddVertex(v3);
            _indices.Add(_vertexOffset);
            _indices.Add(_vertexOffset + 1);
            _indices.Add(_vertexOffset + 2);
            _vertexOffset += 3;
        }

        private void AddVertex(ComApi.InwSimpleVertex v)
        {
            Array coord = (Array)v.coord;
            _positions.Add(Convert.ToSingle(coord.GetValue(0)));
            _positions.Add(Convert.ToSingle(coord.GetValue(1)));
            _positions.Add(Convert.ToSingle(coord.GetValue(2)));
            try
            {
                Array norm = (Array)v.normal;
                _normals.Add(Convert.ToSingle(norm.GetValue(0)));
                _normals.Add(Convert.ToSingle(norm.GetValue(1)));
                _normals.Add(Convert.ToSingle(norm.GetValue(2)));
            }
            catch
            {
                _normals.Add(0f);
                _normals.Add(0f);
                _normals.Add(1f);
            }
        }

        public void Line(ComApi.InwSimpleVertex v1, ComApi.InwSimpleVertex v2) { }
        public void Point(ComApi.InwSimpleVertex v) { }
        public void SnapPoint(ComApi.InwSimpleVertex v) { }
    }
}
"@

$GlbWriterCs = @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Globalization;

namespace NavisworksGLBExporter
{
    public static class GLBWriter
    {
        public static void Write(string filePath,
                                 List<float> positions,
                                 List<float> normals,
                                 List<uint>  indices)
        {
            int vertexCount = positions.Count / 3;

            float minX = float.MaxValue, minY = float.MaxValue, minZ = float.MaxValue;
            float maxX = float.MinValue, maxY = float.MinValue, maxZ = float.MinValue;
            for (int i = 0; i < positions.Count; i += 3)
            {
                float x = positions[i], y = positions[i + 1], z = positions[i + 2];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }

            byte[] posBytes = new byte[positions.Count * 4];
            Buffer.BlockCopy(positions.ToArray(), 0, posBytes, 0, posBytes.Length);
            byte[] nrmBytes = new byte[normals.Count * 4];
            Buffer.BlockCopy(normals.ToArray(), 0, nrmBytes, 0, nrmBytes.Length);
            byte[] idxBytes = new byte[indices.Count * 4];
            Buffer.BlockCopy(indices.ToArray(), 0, idxBytes, 0, idxBytes.Length);

            int idxPad = (4 - (idxBytes.Length % 4)) % 4;
            int posOffset = 0;
            int nrmOffset = posBytes.Length;
            int idxOffset = nrmOffset + nrmBytes.Length;
            int totalBinarySize = idxOffset + idxBytes.Length + idxPad;

            byte[] binaryBuffer = new byte[totalBinarySize];
            Buffer.BlockCopy(posBytes, 0, binaryBuffer, posOffset, posBytes.Length);
            Buffer.BlockCopy(nrmBytes, 0, binaryBuffer, nrmOffset, nrmBytes.Length);
            Buffer.BlockCopy(idxBytes, 0, binaryBuffer, idxOffset, idxBytes.Length);

            var inv = CultureInfo.InvariantCulture;
            string json = "{"
                + "\"asset\":{\"version\":\"2.0\",\"generator\":\"Navisworks GLB Exporter\"},"
                + "\"scene\":0,"
                + "\"scenes\":[{\"nodes\":[0]}],"
                + "\"nodes\":[{\"mesh\":0}],"
                + "\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":0,\"NORMAL\":1},\"indices\":2,\"mode\":4}]}],"
                + "\"accessors\":["
                    + "{\"bufferView\":0,\"componentType\":5126,\"count\":" + vertexCount + ",\"type\":\"VEC3\","
                    + "\"min\":[" + minX.ToString(inv) + "," + minY.ToString(inv) + "," + minZ.ToString(inv) + "],"
                    + "\"max\":[" + maxX.ToString(inv) + "," + maxY.ToString(inv) + "," + maxZ.ToString(inv) + "]},"
                    + "{\"bufferView\":1,\"componentType\":5126,\"count\":" + vertexCount + ",\"type\":\"VEC3\"},"
                    + "{\"bufferView\":2,\"componentType\":5125,\"count\":" + indices.Count + ",\"type\":\"SCALAR\"}"
                + "],"
                + "\"bufferViews\":["
                    + "{\"buffer\":0,\"byteOffset\":" + posOffset + ",\"byteLength\":" + posBytes.Length + ",\"target\":34962},"
                    + "{\"buffer\":0,\"byteOffset\":" + nrmOffset + ",\"byteLength\":" + nrmBytes.Length + ",\"target\":34962},"
                    + "{\"buffer\":0,\"byteOffset\":" + idxOffset + ",\"byteLength\":" + idxBytes.Length + ",\"target\":34963}"
                + "],"
                + "\"buffers\":[{\"byteLength\":" + totalBinarySize + "}]"
                + "}";

            byte[] jsonBytes = Encoding.UTF8.GetBytes(json);
            int jsonPad = (4 - (jsonBytes.Length % 4)) % 4;
            int jsonChunkLen = jsonBytes.Length + jsonPad;
            int binaryChunkLen = totalBinarySize;
            int totalLength = 12 + 8 + jsonChunkLen + 8 + binaryChunkLen;

            using (var fs = new FileStream(filePath, FileMode.Create))
            using (var bw = new BinaryWriter(fs))
            {
                bw.Write(new byte[] { 0x67, 0x6C, 0x54, 0x46 });
                bw.Write(2);
                bw.Write(totalLength);
                bw.Write(jsonChunkLen);
                bw.Write(new byte[] { 0x4E, 0x4F, 0x53, 0x4A });
                bw.Write(jsonBytes);
                bw.Write(new byte[jsonPad]);
                bw.Write(binaryChunkLen);
                bw.Write(new byte[] { 0x00, 0x4E, 0x49, 0x42 });
                bw.Write(binaryBuffer);
            }
        }
    }
}
'@

$AssemblyInfoCs = @'
using System.Reflection;
using System.Runtime.InteropServices;
[assembly: AssemblyTitle("NavisworksGLBExporter")]
[assembly: AssemblyDescription("Export Navisworks models to GLB")]
[assembly: AssemblyCompany("MYCOMPANY")]
[assembly: AssemblyProduct("NavisworksGLBExporter")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: ComVisible(false)]
[assembly: Guid("a1b2c3d4-e5f6-7890-abcd-ef1234567890")]
'@

Set-Content -Path (Join-Path $SrcDir "GLBExporterPlugin.cs") -Value $PluginCs -Encoding UTF8
Set-Content -Path (Join-Path $SrcDir "GLBModelExporter.cs") -Value $ExporterCs -Encoding UTF8
Set-Content -Path (Join-Path $SrcDir "GLBWriter.cs") -Value $GlbWriterCs -Encoding UTF8
Set-Content -Path (Join-Path $SrcDir "AssemblyInfo.cs") -Value $AssemblyInfoCs -Encoding UTF8
Write-Host "  Source files written." -ForegroundColor Green

# ---------- STEP 5: Write .csproj ----------
Write-Host ""
Write-Host "[5/6] Writing project file..." -ForegroundColor Yellow

$CsprojLines = @()
$CsprojLines += '<?xml version="1.0" encoding="utf-8"?>'
$CsprojLines += '<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">'
$CsprojLines += '  <PropertyGroup>'
$CsprojLines += '    <Configuration Condition=" ''$(Configuration)'' == '''' ">Release</Configuration>'
$CsprojLines += '    <Platform Condition=" ''$(Platform)'' == '''' ">AnyCPU</Platform>'
$CsprojLines += '    <ProjectGuid>{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}</ProjectGuid>'
$CsprojLines += '    <OutputType>Library</OutputType>'
$CsprojLines += '    <RootNamespace>NavisworksGLBExporter</RootNamespace>'
$CsprojLines += '    <AssemblyName>NavisworksGLBExporter</AssemblyName>'
$CsprojLines += '    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>'
$CsprojLines += '    <FileAlignment>512</FileAlignment>'
$CsprojLines += '    <Deterministic>true</Deterministic>'
$CsprojLines += '    <PlatformTarget>x64</PlatformTarget>'
$CsprojLines += '  </PropertyGroup>'
$CsprojLines += '  <PropertyGroup Condition=" ''$(Configuration)'' == ''Release'' ">'
$CsprojLines += '    <DebugType>pdbonly</DebugType>'
$CsprojLines += '    <Optimize>true</Optimize>'
$CsprojLines += '    <OutputPath>build\</OutputPath>'
$CsprojLines += '    <DefineConstants>TRACE</DefineConstants>'
$CsprojLines += '  </PropertyGroup>'
$CsprojLines += '  <ItemGroup>'
$CsprojLines += '    <Reference Include="System" />'
$CsprojLines += '    <Reference Include="System.Core" />'
$CsprojLines += '    <Reference Include="System.Windows.Forms" />'
$CsprojLines += '    <Reference Include="System.Drawing" />'
$CsprojLines += '    <Reference Include="PresentationFramework" />'
$CsprojLines += '    <Reference Include="WindowsBase" />'
$CsprojLines += "    <Reference Include=`"$AdWinAsmName`">"
$CsprojLines += "      <HintPath>$AdWinPath</HintPath>"
$CsprojLines += '      <Private>False</Private>'
$CsprojLines += '    </Reference>'
$CsprojLines += "    <Reference Include=`"$ApiAsmName`">"
$CsprojLines += "      <HintPath>$NwApiPath</HintPath>"
$CsprojLines += '      <Private>False</Private>'
$CsprojLines += '    </Reference>'
$CsprojLines += "    <Reference Include=`"$ComApiAsmName`">"
$CsprojLines += "      <HintPath>$NwComApiPath</HintPath>"
$CsprojLines += '      <Private>False</Private>'
$CsprojLines += '    </Reference>'
$CsprojLines += "    <Reference Include=`"$InteropAsmName`">"
$CsprojLines += "      <HintPath>$NwInteropPath</HintPath>"
$CsprojLines += '      <Private>False</Private>'
$CsprojLines += '    </Reference>'
$CsprojLines += '  </ItemGroup>'
$CsprojLines += '  <ItemGroup>'
$CsprojLines += '    <Compile Include="src\GLBExporterPlugin.cs" />'
$CsprojLines += '    <Compile Include="src\GLBModelExporter.cs" />'
$CsprojLines += '    <Compile Include="src\GLBWriter.cs" />'
$CsprojLines += '    <Compile Include="src\AssemblyInfo.cs" />'
$CsprojLines += '  </ItemGroup>'
$CsprojLines += '  <Import Project="$(MSBuildToolsPath)\Microsoft.CSharp.targets" />'
$CsprojLines += '</Project>'

$CsprojPath = Join-Path $RootDir "$ProjectName.csproj"
$CsprojLines | Set-Content -Path $CsprojPath -Encoding UTF8
Write-Host "  .csproj written." -ForegroundColor Green

# ---------- STEP 6: Build & Deploy ----------
Write-Host ""
Write-Host "[6/6] Building with MSBuild..." -ForegroundColor Yellow

& $MSBuild $CsprojPath /p:Configuration=Release /v:minimal /nologo

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "BUILD FAILED (exit code $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
}

$BuiltDll = Join-Path $BuildDir "$ProjectName.dll"
if (-not (Test-Path $BuiltDll)) {
    Write-Host "ERROR: DLL not found at $BuiltDll" -ForegroundColor Red
    exit 1
}
Write-Host "  Built: $BuiltDll" -ForegroundColor Green

# Clean old deploy
if (Test-Path $BundleContentsDir) {
    Get-ChildItem $BundleContentsDir -Filter "*.dll" | Remove-Item -Force -ErrorAction SilentlyContinue
}

Copy-Item -Path $BuiltDll -Destination $BundleContentsDir -Force

$PackageXml = @"
<?xml version="1.0" encoding="utf-8"?>
<ApplicationPackage SchemaVersion="1.0"
                    AppVersion="1.0"
                    ProductCode="{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}"
                    Name="$ProjectName"
                    Description="Navisworks GLB Exporter"
                    Author="$CompanyName">
  <CompanyDetails Name="$CompanyName" />
  <Components Description="Navisworks $NavisworksYear">
    <RuntimeRequirements OS="Win64" Platform="NAVMAN|NAVSIM"
                         SeriesMin="$NavisworksSeries" SeriesMax="$NavisworksSeries" />
    <ComponentEntry AppName="NavisworksGLBExporter"
                    Version="1.0.0"
                    ModuleName="./Contents/v$NavisworksSeries/$ProjectName.dll"
                    AppType="ManagedPlugin" />
  </Components>
</ApplicationPackage>
"@

Set-Content -Path (Join-Path $BundleDir "PackageContents.xml") -Value $PackageXml -Encoding UTF8
Write-Host "  Deployed to: $BundleDir" -ForegroundColor Green

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " BUILD & DEPLOYMENT COMPLETE" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Close Navisworks if running."
Write-Host "  2. Open Navisworks 2025 Manage."
Write-Host "  3. Open your .nwc file."
Write-Host "  4. SELECT a small portion of the model."
Write-Host "  5. Go to 'Tool add-ins 1' tab -> click 'GLB Exporter'."
Write-Host "  6. Save the .glb and drag it into Open BIM Studio."
