/** Stable categories a caller can branch on without parsing messages. */
export type BrowserAdapterErrorCode =
  | "chrome_not_found"
  | "chrome_incompatible"
  | "invalid_configuration"
  | "data_directory_conflict"
  | "profile_corrupted"
  | "launch_failed"
  | "runtime_unavailable"
  | "runtime_ipc_failure"
  | "runtime_operation_failed"
  | "unsupported_isolation"
  | "cdp_timeout"
  | "cdp_disconnected"
  | "browser_exited"
  | "config_apply_failed"
  | "config_verification_failed"
  | "environment_not_found"
  | "environment_already_running"
  | "target_not_found"
  | "persistence_corrupted"
  | "internal_error";

export type BrowserAdapterErrorDetails = Record<string, unknown>;

/**
 * Typed adapter failure. Messages are safe for logs: they never include
 * cookies, tokens or profile contents.
 */
export class BrowserAdapterError extends Error {
  readonly code: BrowserAdapterErrorCode;
  readonly details: BrowserAdapterErrorDetails | undefined;

  constructor(
    code: BrowserAdapterErrorCode,
    message: string,
    details?: BrowserAdapterErrorDetails,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BrowserAdapterError";
    this.code = code;
    this.details = details;
  }
}

export function isBrowserAdapterError(
  value: unknown,
): value is BrowserAdapterError {
  return value instanceof BrowserAdapterError;
}
