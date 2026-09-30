# Creates the "Pi Web" shortcut in the Start menu (run once; re-run to refresh).
$ErrorActionPreference = 'Stop'

$proj   = 'C:\Users\Hp\Desktop\projects\pi-web'
$lnkDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnk    = Join-Path $lnkDir 'Pi Web.lnk'

$ws  = New-Object -ComObject WScript.Shell
$sc  = $ws.CreateShortcut($lnk)
$sc.TargetPath       = 'C:\Windows\System32\wscript.exe'
$sc.Arguments        = '"' + (Join-Path $proj 'app-launcher.vbs') + '"'
$sc.WorkingDirectory = $proj
$sc.IconLocation     = (Join-Path $proj 'pi-web.ico') + ',0'
$sc.Description      = 'pi-web - a browser GUI for the pi coding agent'
$sc.Save()

Write-Output ("Shortcut: " + $lnk)
Write-Output ("Exists:   " + (Test-Path $lnk))
