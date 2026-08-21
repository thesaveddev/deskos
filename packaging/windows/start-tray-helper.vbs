Option Explicit

Dim shell, fso, agent, config, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

agent = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "reydesk-agent.exe")
config = shell.ExpandEnvironmentStrings("%ProgramData%") & "\DeskOS\deskos-agent.json"
command = Chr(34) & agent & Chr(34) & " tray-ui --config " & Chr(34) & config & Chr(34)
shell.Run command, 0, False
