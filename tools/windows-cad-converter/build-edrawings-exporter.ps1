$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourcePath = Join-Path $ScriptDir "edrawings-stl-exporter\EdrawingsStlExporter.cs"
$OutDir = Join-Path $ScriptDir "edrawings-stl-exporter\bin"
$OutExe = Join-Path $OutDir "EdrawingsStlExporter.exe"

function Find-FirstFile {
  param(
    [string[]] $Roots,
    [string] $Filter
  )

  foreach ($root in $Roots) {
    if (-not $root -or -not (Test-Path $root)) {
      continue
    }

    $match = Get-ChildItem -Path $root -Filter $Filter -Recurse -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($match) {
      return $match.FullName
    }
  }

  return $null
}

$CommonFilesX86 = [Environment]::GetEnvironmentVariable("CommonProgramFiles(x86)")
$SearchRoots = @(
  $env:CommonProgramFiles,
  $CommonFilesX86,
  (Join-Path $env:ProgramFiles "SOLIDWORKS Corp"),
  ${env:ProgramFiles(x86)}
)

$InteropPath = Find-FirstFile -Roots $SearchRoots -Filter "eDrawings.Interop.EModelViewControl.dll"
if (-not $InteropPath) {
  throw "Could not find eDrawings.Interop.EModelViewControl.dll. Install 64-bit eDrawings, then rerun this script."
}

$CscCandidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$CscPath = $CscCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $CscPath) {
  throw "Could not find csc.exe from .NET Framework 4.x. Install .NET Framework developer tools or Visual Studio Build Tools."
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

& $CscPath `
  /nologo `
  /target:exe `
  /platform:x64 `
  /optimize+ `
  "/out:$OutExe" `
  "/reference:System.dll" `
  "/reference:System.Drawing.dll" `
  "/reference:System.Windows.Forms.dll" `
  "/reference:$InteropPath" `
  $SourcePath

Copy-Item -Force $InteropPath (Join-Path $OutDir (Split-Path -Leaf $InteropPath))

Write-Host "Built $OutExe"
