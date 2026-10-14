; Glass Tasks Widget — custom NSIS steps (picked up by electron-builder, see package.json nsis.include).
; Saved as UTF-8 with BOM: NSIS reads the Russian strings correctly only with the BOM.

; Optional removal of the user's data on uninstall.
; electron-builder's deleteAppDataOnUninstall would erase it unconditionally (habit history,
; backups and Google sign-in included), so instead the user is asked, with «No» as the default.
; Never asked and never deleted on updates (the old uninstaller runs with --updated) or in
; silent mode; a silent uninstall can still pass --delete-app-data (handled by the template).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      ${if} $isDeleteAppData != "1"
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Удалить также ваши данные Glass Tasks Widget?$\r$\n$\r$\nБудут стёрты настройки, история привычек, резервные копии, ключи Google и вход в аккаунт (папка %APPDATA%\${APP_PACKAGE_NAME}). Задачи в самом Google Tasks не пострадают.$\r$\n$\r$\nНажмите «Нет», чтобы сохранить данные для повторной установки." /SD IDNO IDNO glassTasksKeepUserData
        ${if} $installMode == "all"
          SetShellVarContext current
        ${endif}
        RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
        ${if} $installMode == "all"
          SetShellVarContext all
        ${endif}
        glassTasksKeepUserData:
      ${endif}
    ${endif}
  ${endif}
!macroend
