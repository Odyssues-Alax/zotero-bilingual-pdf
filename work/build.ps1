param([string]$Output = "")
$ErrorActionPreference = 'Stop'
$source=Join-Path $PSScriptRoot 'addon'
$version = (Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if (-not $Output) {
  $Output = Join-Path (Split-Path $PSScriptRoot) "outputs\bilingual-pdf-$version.xpi"
}
$Output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output)
if(Test-Path -LiteralPath $Output){throw 'Output exists; choose a new file.'}
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Output)) | Out-Null
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::Open($Output,[IO.Compression.ZipArchiveMode]::Create)
try {
Get-ChildItem -LiteralPath $source -Recurse -File | Where-Object {$_.FullName -notmatch '[\\/]__pycache__[\\/]' -and $_.Extension -ne '.pyc'} | ForEach-Object {
  $name=$_.FullName.Substring($source.Length+1).Replace('\','/')
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$_.FullName,$name,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
}
}finally{$zip.Dispose()}
Get-Item -LiteralPath $Output | Select-Object FullName,Length
