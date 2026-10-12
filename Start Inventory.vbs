Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
projectFolder = fileSystem.GetParentFolderName(WScript.ScriptFullName)
scriptPath = projectFolder & "\start-inventory.ps1"
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & scriptPath & Chr(34), 0, False
