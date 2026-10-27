; electron-builder includes this file through `nsis.include`. The customInstall
; macro runs after installApplicationFiles, so the whole application tree is on
; disk by the time it executes.
!macro customInstall
  ; NSIS extracts files from an archive and does not preserve the ACL that
  ; after-pack applies to win-unpacked. Electron's sandboxed renderer reads the
  ; install directory through ALL APPLICATION PACKAGES, so grant read/execute
  ; again on the installed tree. Without this Electron refuses to start with
  ; "Sandboxed processes cannot read <dir>".
  ;
  ; Use the System32 copy instead of resolving icacls through PATH. /T applies
  ; the ACE to the files already extracted; /C keeps going past an individual
  ; failure; /Q suppresses successful-output noise.
  nsExec::ExecToLog `"$SYSDIR\icacls.exe" "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX) /T /C /Q`
  Pop $0
  IntCmp $0 0 virealm_acl_granted
    ; An installed app whose renderer cannot read its own directory is worse
    ; than no install: fail the installer instead of leaving it behind. Silent
    ; installs (CI) must not block on a dialog, so only interactive installs
    ; show the explanation; both exit with a non-zero status.
    IfSilent virealm_acl_failed_silent
    MessageBox MB_ICONSTOP|MB_OK "Virealm could not grant the sandbox the read permission it needs on the install directory (icacls exit code $0). The installation is incomplete; please retry."
  virealm_acl_failed_silent:
    SetErrorLevel 1
    Quit
  virealm_acl_granted:
!macroend
