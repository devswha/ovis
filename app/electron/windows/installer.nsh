; The desktop app replaces Ovis for Windows (app/windows), the one-file setup app. That app has no
; uninstaller of its own, and its Remove button also takes the Ovis server off the PC, so it is never
; run. What it leaves on the PC is three things (app/windows/src/LoginItem.cs): its copy at
; %LOCALAPPDATA%\Programs\Ovis\Ovis.exe, a Start menu Ovis.lnk, and an HKCU Run value "Ovis" that
; starts that copy with --start at sign-in. By the time customInstall runs, this app's own Ovis.lnk has
; replaced that Start menu shortcut (same name), so the Run value and the copy are what go here.
; herdr, the Ovis server it installed and their state stay as they are.

!macro customInstall
  StrCpy $0 "$LOCALAPPDATA\Programs\Ovis"
  ; never this app's own folder, whatever it is installed as
  ${if} "$INSTDIR" != "$0"
  ${andIf} ${FileExists} "$0\Ovis.exe"
    ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Ovis"
    ; only the value that app writes: one the user pointed elsewhere is theirs
    ${if} $1 == '"$0\Ovis.exe" --start'
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Ovis"
    ${endIf}
    ; an open window holds the file: it stays then, with no Start menu entry or sign-in start left to run it
    ClearErrors
    Delete "$0\Ovis.exe"
    ; only when nothing else is in the folder
    RMDir "$0"
    ClearErrors
  ${endIf}
!macroend
