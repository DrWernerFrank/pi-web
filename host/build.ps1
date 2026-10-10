# Compile PiWebHost.exe with the compiler Windows already has (csc from
# .NET Framework 4.x) — no SDK needed. Run host\get-webview2.ps1 first.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }

Push-Location $root
& $csc /nologo /target:winexe /out:PiWebHost.exe `
	/r:Microsoft.Web.WebView2.Core.dll `
	/r:Microsoft.Web.WebView2.WinForms.dll `
	/r:System.dll /r:System.Core.dll `
	/r:System.Windows.Forms.dll /r:System.Drawing.dll `
	PiWebHost.cs
$code = $LASTEXITCODE
Pop-Location
if ($code -eq 0) { Write-Output ("built: " + (Join-Path $root 'PiWebHost.exe')) } else { exit $code }
