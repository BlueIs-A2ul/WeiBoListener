Option Explicit

Dim fso, shell, root, exitCode

Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = root

' Window style 0 = hidden, True = wait for the batch to finish.
' Waiting keeps the scheduled task in Running state and lets Task Scheduler restart it on failure.
exitCode = shell.Run("cmd /c """ & root & "\start.bat""", 0, True)

WScript.Quit exitCode
