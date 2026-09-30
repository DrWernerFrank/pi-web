' Pi Web — Windows app launcher.
' Ensures the pi-web server is running inside WSL (hidden window), then opens
' Chrome in app mode: its own window on the taskbar, with pi-web's icon.
' The shortcut in the Start menu points here.

Option Explicit
Dim shell, ready, tries
Set shell = CreateObject("WScript.Shell")

Function ServerUp()
	On Error Resume Next
	Err.Clear
	Dim x
	Set x = CreateObject("MSXML2.XMLHTTP")
	x.Open "GET", "http://localhost:3141/api/health", False
	x.Send
	If Err.Number = 0 And x.Status = 200 Then
		ServerUp = True
	Else
		ServerUp = False
	End If
	Set x = Nothing
	On Error Goto 0
End Function

If Not ServerUp() Then
	' Start pi-web in WSL without a visible window ("pi-web start" runs it in tmux).
	shell.Run "wsl.exe -d Ubuntu -- bash -lic ""pi-web start --no-open""", 0, False
	For tries = 1 To 120
		If ServerUp() Then
			ready = True
			Exit For
		End If
		WScript.Sleep 1000
	Next
Else
	ready = True
End If

If ready Then
	shell.Run """C:\Program Files\Google\Chrome\Application\chrome.exe"" --app=http://localhost:3141/", 1, False
Else
	MsgBox "pi-web did not start within two minutes." & vbCrLf & vbCrLf & _
		"Open a WSL terminal and run:  pi-web logs" & vbCrLf & _
		"to see what went wrong.", 16, "Pi Web"
End If
