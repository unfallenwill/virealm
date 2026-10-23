import type { LogEntryView } from "../shared/contracts.js";

const MAX_ENTRIES = 300;

/**
 * Diagnostic ring buffer for the UI.
 *
 * Messages are redacted on the way in, so neither the renderer nor a copied
 * report can contain debugger paths, cookies or authorization values.
 */
export class DesktopLog {
  private readonly entries: LogEntryView[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limit = MAX_ENTRIES,
  ) {}

  info(code: string, message: string, environmentId?: string): void {
    this.add("info", code, message, environmentId);
  }

  warn(code: string, message: string, environmentId?: string): void {
    this.add("warn", code, message, environmentId);
  }

  error(code: string, message: string, environmentId?: string): void {
    this.add("error", code, message, environmentId);
  }

  list(environmentId?: string): readonly LogEntryView[] {
    const selected =
      environmentId === undefined
        ? this.entries
        : this.entries.filter(
            (entry) =>
              entry.environmentId === undefined ||
              entry.environmentId === environmentId,
          );
    return [...selected];
  }

  private add(
    level: LogEntryView["level"],
    code: string,
    message: string,
    environmentId: string | undefined,
  ): void {
    this.entries.push({
      atUnixMs: this.now(),
      level,
      code,
      message: redactMessage(message),
      environmentId,
    });
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
  }
}

const DEBUGGER_PATH = /(wss?:\/\/[^/\s]+)\/devtools\/browser\/[^\s"']+/gi;
// Redact the value including an optional bearer/basic/token scheme. Without
// the scheme group, "Authorization: Bearer abc" would keep the token.
const SECRET_ASSIGNMENT =
  /\b(cookie|authorization|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?[^\s,;"']+/gi;
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;

/** Keep diagnostic text useful while removing values that grant access. */
export function redactMessage(message: string): string {
  return message
    .replace(DEBUGGER_PATH, "$1/devtools/browser/[redacted]")
    .replace(SECRET_ASSIGNMENT, "$1=[redacted]")
    .replace(LONG_HEX, "[redacted]");
}
