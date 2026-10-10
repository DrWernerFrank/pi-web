# Fetch the WebView2 NuGet packages (nupkg = zip) and extract the .NET Framework DLLs.
# Host-side tooling for PiWebHost.exe (the native app shell). Run from WSL:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File host\get-webview2.ps1
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $MyInvocation.MyCommand.Path   # ...\pi-web\host
$nupkg = Join-Path $root 'nuget'
$tmp   = Join-Path $root 'nuget\extracted'
$v     = '1.0.2903.40'

New-Item -ItemType Directory -Force -Path $nupkg, $tmp | Out-Null

foreach ($pkg in @('Microsoft.Web.WebView2', 'Microsoft.Web.WebView2.WinForms')) {
	$zip = Join-Path $nupkg "$pkg.zip"
	if (-not (Test-Path $zip)) {
		Invoke-WebRequest -Uri "https://www.nuget.org/api/v2/package/$pkg/$v" -OutFile $zip -UseBasicParsing
	}
	$dest = Join-Path $tmp $pkg
	Expand-Archive -Path $zip -DestinationPath $dest -Force
	# net462 builds (run on any .NET Framework >= 4.6.2; no SDK needed)
	$dlls = Get-ChildItem (Join-Path $dest 'lib\net462') -Filter *.dll
	foreach ($dll in $dlls) { Copy-Item $dll.FullName $root -Force }
	# The native loader the wrappers P/Invoke — must sit next to the exe.
	$loader = Join-Path $dest 'runtimes\win-x64\native\WebView2Loader.dll'
	if (Test-Path $loader) { Copy-Item $loader $root -Force }
	Write-Output ("{0}: {1} (+loader)" -f $pkg, $v)
}
Write-Output ("DLLs in host: " + ((Get-ChildItem $root -Filter *.dll).Name -join ', '))
