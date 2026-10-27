#!/usr/bin/env bash
set -euo pipefail

release_dir="${1:-apps/desktop/release}"
expected_version="${2:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to inspect the runtime capability report" >&2
  exit 1
fi

shopt -s nullglob
if [[ -n "$expected_version" ]]; then
  candidates=("$release_dir"/Virealm-"$expected_version"-mac-*.dmg)
else
  candidates=("$release_dir"/*.dmg)
fi

if [[ ${#candidates[@]} -eq 0 ]]; then
  echo "no matching .dmg found in $release_dir" >&2
  exit 1
fi
if [[ ${#candidates[@]} -gt 1 ]]; then
  echo "expected exactly one matching .dmg in $release_dir, found:" >&2
  printf '  %s\n' "${candidates[@]}" >&2
  exit 1
fi
dmg="${candidates[0]}"

mount="$(mktemp -d)"
cleanup() {
  # -force keeps a failed check from leaving the image mounted; the mount point
  # is a private mktemp directory, so this cannot affect another volume.
  hdiutil detach "$mount" -force -quiet >/dev/null 2>&1 || true
  rmdir "$mount" 2>/dev/null || true
}
trap cleanup EXIT

hdiutil attach "$dmg" -mountpoint "$mount" -nobrowse -readonly -quiet

app="$mount/Virealm.app"
app_executable="$app/Contents/MacOS/Virealm"
runtime="$app/Contents/Resources/runtime/virealm-runtime"
info_plist="$app/Contents/Info.plist"

for path in "$app" "$app_executable" "$runtime" "$info_plist"; do
  if [[ ! -e "$path" ]]; then
    echo "missing from the DMG: $path" >&2
    exit 1
  fi
done

if [[ ! -x "$app_executable" ]]; then
  echo "the application executable is not executable: $app_executable" >&2
  exit 1
fi
if [[ ! -x "$runtime" ]]; then
  echo "the bundled runtime is not executable: $runtime" >&2
  exit 1
fi
if ! file "$runtime" | grep -q "Mach-O"; then
  echo "the bundled runtime is not Mach-O: $runtime" >&2
  exit 1
fi

bundle_id="$(
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist"
)"
if [[ "$bundle_id" != "com.virealm.desktop" ]]; then
  echo "unexpected CFBundleIdentifier: $bundle_id" >&2
  exit 1
fi

probe_json="$("$runtime" probe)"
if ! jq -e '
  .capabilities.platform.os == "macos"
  and .capabilities.processGroup.state == "supported"
' <<<"$probe_json" >/dev/null; then
  echo "the bundled runtime did not report macOS with process-group support" >&2
  echo "$probe_json" >&2
  exit 1
fi

if [[ -n "$expected_version" ]]; then
  actual_version="$(
    /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info_plist"
  )"
  if [[ "$actual_version" != "$expected_version" ]]; then
    echo "DMG version $actual_version does not match expected $expected_version" >&2
    exit 1
  fi
fi

echo "[verify-dmg] $(basename "$dmg") contains a runnable runtime${expected_version:+ and version $expected_version}"
