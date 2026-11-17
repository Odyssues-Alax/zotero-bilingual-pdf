param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$Root=[IO.Path]::GetFullPath($Root)
[IO.Directory]::CreateDirectory($Root)|Out-Null
$env:UV_CACHE_DIR=Join-Path $Root 'uv-cache';$env:UV_PYTHON_INSTALL_DIR=Join-Path $Root 'python';$env:UV_LINK_MODE='copy'
$env:TEMP=Join-Path $Root 'tmp';$env:TMP=$env:TEMP;[IO.Directory]::CreateDirectory($env:TEMP)|Out-Null
function Progress([string]$Message){@{type='progress';message=$Message}|ConvertTo-Json -Compress}
try{
 $venv=Join-Path $Root 'venv-managed';$python=Join-Path $venv 'Scripts\python.exe'
 $uv=Get-Command uv.exe -ErrorAction SilentlyContinue
 if($uv){$uvPath=$uv.Source}else{
  Progress '下载本机安装工具…'
  $tools=Join-Path $Root 'tools';[IO.Directory]::CreateDirectory($tools)|Out-Null
  $url='https://github.com/astral-sh/uv/releases/download/0.11.24/uv-x86_64-pc-windows-msvc.zip'
  $archive=Join-Path $tools 'uv.zip';$check=Join-Path $tools 'uv.zip.sha256'
  Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing -TimeoutSec 180
  Invoke-WebRequest -Uri ($url+'.sha256') -OutFile $check -UseBasicParsing -TimeoutSec 60
  $expected=([IO.File]::ReadAllText($check).Trim() -split '\s+')[0]
  if($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected){throw '安装工具校验失败，未运行。'}
  Expand-Archive -LiteralPath $archive -DestinationPath $tools -Force
  $uvPath=(Get-ChildItem -LiteralPath $tools -Filter 'uv.exe' -Recurse | Select-Object -First 1).FullName
  if(!$uvPath){throw '没有找到安装工具。'}
 }
 if(!(Test-Path -LiteralPath $python)){
  Progress '安装隔离 Python 运行环境…'
  & $uvPath venv --python 3.12.13 --managed-python $venv
  if($LASTEXITCODE -ne 0){throw 'Python 运行环境安装失败，可重新安装继续。'}
 }
 Progress '安装已固定版本的 PDF 引擎依赖…'
 & $uvPath pip install --python $python --requirements (Join-Path $PSScriptRoot 'requirements.txt')
 if($LASTEXITCODE -ne 0){throw 'PDF 引擎依赖安装失败，可重新安装继续。'}
 @{type='result';ready=$true;version='0.6.4'}|ConvertTo-Json -Compress
}catch{
 @{type='error';message='本机引擎安装失败；请检查网络、磁盘空间后重新安装。'}|ConvertTo-Json -Compress
 exit 1
}
