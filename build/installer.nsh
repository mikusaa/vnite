!macro customInstall
  DetailPrint "Register vnite URI Handler"
  DeleteRegKey HKCR "vnite"
  WriteRegStr HKCR "vnite" "" "URL:Vnite Protocol"
  WriteRegStr HKCR "vnite" "URL Protocol" ""
  WriteRegStr HKCR "vnite\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCR "vnite\shell" "" ""
  WriteRegStr HKCR "vnite\shell\Open" "" ""
  WriteRegStr HKCR "vnite\shell\Open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\""
!macroend

!macro customRemoveFiles
  ${ifNot} ${isUpdated}
    DetailPrint "Removing Vnite administrator startup tasks"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --vnite-startup-uninstall' $R0
    StrCmp $R0 0 startup_cleanup_done
      MessageBox MB_ICONEXCLAMATION|MB_OK "Could not remove Vnite startup tasks. Please close Vnite and retry uninstalling."
      Abort
    startup_cleanup_done:
  ${endif}
  DeleteRegKey HKCR "vnite"
  Push $R1
  Push $R2

  FindFirst $R1 $R2 "$INSTDIR\*.*"

  ;IfFileExists "$INSTDIR\app\*.*" loop not_app
  ;not_app:
  ;  RMDir /r $INSTDIR
  ;  Goto done

  loop:
    StrCmp $R2 "" done

    StrCmp $R2 "." continue
    StrCmp $R2 ".." continue
    StrCmp $R2 "app" continue

    Delete "$INSTDIR\$R2"
    RMDir /r "$INSTDIR\$R2"

    Goto continue

    continue:
      FindNext $R1 $R2
      Goto loop

  done:
    FindClose $R1
    Pop $R1
    Pop $R2
!macroend
