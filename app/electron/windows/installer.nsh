; The desktop app replaces Ovis for Windows (app/windows, the one-file setup app):
; replace-old-setup.ps1 takes that app's copy, sign-in start and shortcuts off the PC, and leaves herdr,
; the Ovis server and their state as they are. customInstall runs after this app's Start menu shortcut
; is made, so a shortcut that script removed (one of that app's, kept by an update) is made again here.

!macro customInstall
  InitPluginsDir
  File "/oname=$PLUGINSDIR\replace-old-setup.ps1" "${PROJECT_DIR}\windows\replace-old-setup.ps1"
  ; a failure leaves that app as it was: nothing of this app's depends on it
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\replace-old-setup.ps1" -NewExe "$appExe"'
  Pop $0
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${ifNot} ${FileExists} "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${endIf}
  !endif
!macroend
