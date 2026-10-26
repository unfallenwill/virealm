import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SUPPORTED_PLATFORM =
  process.platform === "win32" || process.platform === "darwin";

export function runtimeExecutableName(platform = process.platform): string {
  return platform === "win32" ? "virealm-runtime.exe" : "virealm-runtime";
}

/** Runtime endpoint used by a test: a named pipe or a Unix socket. */
export function runtimeEndpoint(root: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\virealm-it-${randomUUID()}`;
  }
  return path.join(root, "runtime.sock");
}

/**
 * Command lines of live Chrome processes whose arguments mention the profile.
 *
 * Both platforms print the full command line: Windows through WMI, macOS
 * through `ps -ww` (without it macOS truncates to the terminal width).
 */
export async function chromeCommandLinesForProfile(
  userDataDir: string,
): Promise<string[]> {
  const lines =
    process.platform === "win32"
      ? await windowsChromeCommandLines()
      : await macosChromeCommandLines();
  return lines.filter((line) => line.includes(userDataDir));
}

async function windowsChromeCommandLines(): Promise<string[]> {
  const script =
    "$items = @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object -ExpandProperty CommandLine); ConvertTo-Json -Compress -InputObject $items";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  const parsed: unknown = JSON.parse(stdout.trim() || "[]");
  if (typeof parsed === "string") {
    return [parsed];
  }
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function macosChromeCommandLines(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-axww", "-o", "pid=,ppid=,pgid=,command="],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => line.includes("Google Chrome") || line.includes("Chromium"),
    );
}
