; Glass Tasks Widget — custom NSIS steps (picked up by electron-builder, see package.json nsis.include).
; Saved as UTF-8 with BOM: NSIS reads the Russian strings correctly only with the BOM.

; On a real uninstall (never on updates: the old uninstaller then runs with --updated):
; 1) Remove the autostart entry. app.setLoginItemSettings() writes it under HKCU with the
;    AppUserModelId as the value name; left behind, it keeps pointing at the deleted exe,
;    and whoever can recreate that path gets code run at the user's every login.
; 2) Offer to remove the user's data. electron-builder's deleteAppDataOnUninstall would erase it
;    unconditionally (habit history, backups and Google sign-in included), so the user is asked,
;    with «No» as the default. Never asked in silent mode; a silent uninstall can still pass
;    --delete-app-data (handled by the template).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.glasstasks.widget"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.glasstasks.widget"
    ${ifNot} ${Silent}
      ; electron-builder 26 declares $isDeleteAppData only after this macro, so check the
      ; flag the same way its template does: ask only when --delete-app-data was not passed.
      ClearErrors
      ${GetParameters} $R0
      ${GetOptions} $R0 "--delete-app-data" $R1
      ${if} ${Errors}
        ${if} $installMode == "all"
          ; Elevated uninstall: %APPDATA% below is the account that elevated, not every user.
          MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Удалить также данные Glass Tasks Widget текущей учётной записи Windows?$\r$\n$\r$\nБудут стёрты настройки, история привычек, резервные копии, ключи Google и вход (папка %APPDATA%\${APP_PACKAGE_NAME} этой учётной записи). Данные других пользователей компьютера останутся. Задачи в самом Google Tasks не пострадают." /SD IDNO IDNO glassTasksKeepUserData
        ${else}
          MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Удалить также ваши данные Glass Tasks Widget?$\r$\n$\r$\nБудут стёрты настройки, история привычек, резервные копии, ключи Google и вход в аккаунт (папка %APPDATA%\${APP_PACKAGE_NAME}). Задачи в самом Google Tasks не пострадают.$\r$\n$\r$\nНажмите «Нет», чтобы сохранить данные для повторной установки." /SD IDNO IDNO glassTasksKeepUserData
        ${endif}
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
