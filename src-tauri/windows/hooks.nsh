; Keep install paths and registry IDs stable; localize only visible names.
LangString LingDongName 1033 "LingDongNews"
LangString LingDongName 2052 "灵动新闻"
LangString LingDongName 1028 "灵动新闻"
Var LingDongInstalled

!macro RestoreNewsShortcut PATH
  !insertmacro IsShortcutTarget "${PATH}\灵动新闻.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    Rename "${PATH}\灵动新闻.lnk" "${PATH}\LingDongNews.lnk"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
  !insertmacro RestoreNewsShortcut "$DESKTOP"
  !insertmacro RestoreNewsShortcut "$SMPROGRAMS"
  !insertmacro RestoreNewsShortcut "$SMPROGRAMS\$AppStartMenuFolder"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  StrCpy $LingDongInstalled 1
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "$(LingDongName)"
  ${If} $LANGUAGE != 1033
    Rename "$SMPROGRAMS\LingDongNews.lnk" "$SMPROGRAMS\$(LingDongName).lnk"
    Rename "$SMPROGRAMS\$AppStartMenuFolder\LingDongNews.lnk" "$SMPROGRAMS\$AppStartMenuFolder\$(LingDongName).lnk"
    Rename "$DESKTOP\LingDongNews.lnk" "$DESKTOP\$(LingDongName).lnk"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
  !insertmacro RestoreNewsShortcut "$DESKTOP"
  !insertmacro RestoreNewsShortcut "$SMPROGRAMS"
  !insertmacro RestoreNewsShortcut "$SMPROGRAMS\$AppStartMenuFolder"
!macroend

; The finish page can create the desktop shortcut after POSTINSTALL.
Function .onGUIEnd
  ${If} $LingDongInstalled == 1
  ${AndIf} $LANGUAGE != 1033
    Rename "$DESKTOP\LingDongNews.lnk" "$DESKTOP\$(LingDongName).lnk"
  ${EndIf}
FunctionEnd
