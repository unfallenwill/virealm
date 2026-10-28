; electron-builder includes this file through `nsis.include`. The customInstall
; macro runs after installApplicationFiles, so the whole application tree is on
; disk by the time it executes.
;
; Two defects let a failed grant look like a successful install:
;
; 1. nsExec pushes the *string* "error" when the process cannot be created and
;    "timeout" when it does not finish (Contrib/nsExec/nsexec.c). NSIS parses
;    integers with a strtoiptr-style loop that returns 0 on a non-numeric
;    string, so `IntCmp $0 0 granted` jumped to success whenever icacls never
;    ran — the install completed without the ACE.
; 2. icacls was resolved from $SYSDIR. NSIS installers are 32-bit, so WOW64
;    redirects $SYSDIR to SysWOW64, and launching a system tool through that
;    redirection is a known source of "cannot execute" failures (NSIS bug 737).
;    Resolve from the native System32 instead.
;
; Both paths are now explicit: icacls is probed for before use, the status is
; compared as a string, and each failure mode gets its own exit code so CI can
; tell them apart instead of reporting a generic failure.
;
; This file is included before the electron-builder templates, so only plain
; NSIS instructions are used here (no LogicLib) and dedicated variables are
; declared instead of borrowing $R0-$R9, which the templates use themselves.
!ifndef VIREALM_ACL_INSTALLER_NSH
!define VIREALM_ACL_INSTALLER_NSH

Var virealmAclTool
Var virealmAclFailure

!macro customInstall
  ; NSIS extracts files from an archive and does not preserve the ACL that
  ; after-pack applies to win-unpacked. Electron's sandboxed renderer reads the
  ; install directory through ALL APPLICATION PACKAGES, so grant read/execute
  ; again on the installed tree. Without this Electron refuses to start with
  ; "Sandboxed processes cannot read <dir>".
  ;
  ; "Sysnative" is the alias that escapes WOW64 redirection and only exists
  ; under WOW64; on 32-bit Windows $SYSDIR is already the native directory.
  StrCpy $virealmAclTool "$WINDIR\Sysnative\icacls.exe"
  IfFileExists "$virealmAclTool" virealm_acl_have_icacls
  StrCpy $virealmAclTool "$SYSDIR\icacls.exe"
  IfFileExists "$virealmAclTool" virealm_acl_have_icacls
    DetailPrint "no icacls.exe found in $WINDIR\Sysnative or $SYSDIR"
    StrCpy $virealmAclFailure "icacls.exe is missing"
    SetErrorLevel 9001
    Goto virealm_acl_failed_message
  virealm_acl_have_icacls:

  ; /T applies the ACE to the files already extracted; /Q suppresses the
  ; successful-output noise. Deliberately no /C: a partial grant must fail the
  ; install rather than leave a tree whose renderer cannot read it.
  DetailPrint "granting ALL APPLICATION PACKAGES read/execute on $INSTDIR via $virealmAclTool"
  nsExec::ExecToLog '"$virealmAclTool" "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX) /T /Q'
  Pop $0

  StrCmp $0 "0" virealm_acl_granted
  StrCmp $0 "error" virealm_acl_launch_failed
  StrCmp $0 "timeout" virealm_acl_timed_out
  ; Any other value is icacls' own exit code; pass it through unchanged.
  SetErrorLevel $0
  StrCpy $virealmAclFailure "icacls exited with '$0'"
  Goto virealm_acl_failed_message

  virealm_acl_launch_failed:
    SetErrorLevel 9002
    StrCpy $virealmAclFailure "icacls could not be started"
    Goto virealm_acl_failed_message

  virealm_acl_timed_out:
    SetErrorLevel 9003
    StrCpy $virealmAclFailure "icacls timed out"
    Goto virealm_acl_failed_message

  virealm_acl_failed_message:
    ; An installed app whose renderer cannot read its own directory is worse
    ; than no install: fail the installer instead of leaving it behind. Silent
    ; installs (CI) must not block on a dialog, so only interactive installs
    ; show the explanation; both exit with a non-zero status.
    IfSilent virealm_acl_failed_silent
    MessageBox MB_ICONSTOP|MB_OK "Virealm could not grant the sandbox the read permission it needs on the install directory ($virealmAclFailure). The installation is incomplete; please retry."
  virealm_acl_failed_silent:
    Quit

  virealm_acl_granted:
!macroend

!endif
