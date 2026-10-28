param(
    [string]$ReleaseDirectory = "apps/desktop/release",
    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion
)

$ErrorActionPreference = "Stop"

function Test-AppContainerReadExecuteAce {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [System.Security.Principal.SecurityIdentifier]$Sid,
        [switch]$RequireInheritance
    )

    $acl = Get-Acl -LiteralPath $Path
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
            continue
        }
        try {
            $ruleSid = $rule.IdentityReference.Translate(
                [System.Security.Principal.SecurityIdentifier]
            )
        } catch {
            continue
        }
        if ($ruleSid.Value -ne $Sid.Value) {
            continue
        }
        $required = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
        if (($rule.FileSystemRights -band $required) -ne $required) {
            continue
        }
        if ($RequireInheritance) {
            if (($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ContainerInherit) -eq 0) {
                continue
            }
            if (($rule.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -eq 0) {
                continue
            }
        }
        return $true
    }
    return $false
}

$installers = @(
    Get-ChildItem -LiteralPath $ReleaseDirectory -Filter *.exe
)
if ($installers.Count -eq 0) {
    throw "no installer (.exe) found in $ReleaseDirectory"
}
if ($installers.Count -gt 1) {
    $names = ($installers | ForEach-Object { $_.Name }) -join ", "
    throw "expected exactly one installer in $ReleaseDirectory, found: $names"
}
$installer = $installers[0]

Write-Host "[verify-installer] installing $($installer.Name) silently"
$install = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -PassThru -Wait
if ($install.ExitCode -ne 0) {
    throw "the installer exited with code $($install.ExitCode)"
}

$uninstaller = $null
$appExecutable = $null
try {
    $uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
    $entry = Get-ChildItem -LiteralPath $uninstallKey |
        Get-ItemProperty |
        Where-Object { $_.DisplayName -like "Virealm*" } |
        Select-Object -First 1

    $installDirectory = if ($null -ne $entry) { $entry.InstallLocation } else { $null }
    if ($null -ne $entry -and -not $installDirectory -and $entry.UninstallString) {
        if ($entry.UninstallString -match '^"([^"]+)"') {
            $uninstallerPath = $matches[1]
        } else {
            $uninstallerPath = ($entry.UninstallString -split '\s+', 2)[0]
        }
        $installDirectory = Split-Path -Parent $uninstallerPath
    }
    if (-not $installDirectory) {
        $installDirectory = Join-Path $env:LOCALAPPDATA "Programs\Virealm"
    }

    $appExecutable = Join-Path $installDirectory "Virealm.exe"
    $runtime = Join-Path $installDirectory "resources\runtime\virealm-runtime.exe"
    $appAsar = Join-Path $installDirectory "resources\app.asar"
    $uninstaller = Join-Path $installDirectory "Uninstall Virealm.exe"

    if ($null -eq $entry) {
        throw "the uninstall registry entry was not created"
    }
    if ($entry.DisplayVersion -ne $ExpectedVersion) {
        throw "uninstall entry DisplayVersion is '$($entry.DisplayVersion)', expected '$ExpectedVersion'"
    }

    foreach ($path in @($appExecutable, $runtime, $appAsar, $uninstaller)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "missing after install: $path"
        }
    }

    $appContainerSid = [System.Security.Principal.SecurityIdentifier]::new(
        "S-1-15-2-1"
    )
    if (-not (Test-AppContainerReadExecuteAce -Path $installDirectory -Sid $appContainerSid -RequireInheritance)) {
        # The assertion below is the only signal that the installer's customInstall
        # grant did not take effect. Dump what actually landed so a CI failure is
        # diagnosable instead of just "missing ACE".
        Write-Host "[verify-installer] $installDirectory contains:"
        Get-ChildItem -LiteralPath $installDirectory |
            Select-Object -ExpandProperty Name |
            ForEach-Object { Write-Host "  $_" }
        Write-Host "[verify-installer] actual ACL:"
        $icacls = Join-Path $env:WINDIR "System32\icacls.exe"
        if (Test-Path -LiteralPath $icacls -PathType Leaf) {
            (& $icacls $installDirectory | Out-String) -split "`r?`n" |
                Where-Object { $_ -ne "" } |
                ForEach-Object { Write-Host "  $_" }
        } else {
            Write-Host "  icacls.exe not found at $icacls"
        }
        throw "the install directory lacks an inheritable ALL APPLICATION PACKAGES read/execute ACE"
    }
    foreach ($path in @($appExecutable, $runtime, $appAsar)) {
        if (-not (Test-AppContainerReadExecuteAce -Path $path -Sid $appContainerSid)) {
            throw "missing ALL APPLICATION PACKAGES read/execute ACE on $path"
        }
    }

    $productVersion = (Get-Item -LiteralPath $appExecutable).VersionInfo.ProductVersion
    if (-not $productVersion.StartsWith(
        $ExpectedVersion,
        [System.StringComparison]::Ordinal
    )) {
        throw "installed ProductVersion is '$productVersion', expected it to start with '$ExpectedVersion'"
    }

    $probe = & $runtime probe | ConvertFrom-Json
    if ($probe.capabilities.platform.os -ne "windows") {
        throw "runtime probe reported platform '$($probe.capabilities.platform.os)'"
    }
    if ($probe.capabilities.jobObject.state -ne "supported") {
        throw "runtime probe reported jobObject '$($probe.capabilities.jobObject.state)'"
    }

    Write-Host "[verify-installer] installed version $productVersion with the required ACL"
} finally {
    if ($null -ne $uninstaller -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        Write-Host "[verify-installer] uninstalling silently"
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList "/S" -PassThru -Wait
        if ($uninstall.ExitCode -ne 0) {
            throw "the uninstaller exited with code $($uninstall.ExitCode)"
        }
    }
}

if ($null -ne $appExecutable -and (Test-Path -LiteralPath $appExecutable -PathType Leaf)) {
    throw "the application executable still exists after uninstall: $appExecutable"
}
Write-Host "[verify-installer] silent install, ACL, version, probe, and uninstall passed"
