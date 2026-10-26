import type { ContractError } from "@virealm/contracts";

/** Failure categories produced by the client itself, distinct from runtime-reported errors. */
export type RuntimeClientErrorCode =
  | "invalid_request"
  | "runtime_unavailable"
  | "connection_timeout"
  | "request_timeout"
  | "request_aborted"
  | "connection_closed"
  | "protocol_violation"
  | "runtime_error"
  | "client_closed"
  | "host_start_failed";

/** Base class so every transport failure can be caught without matching messages. */
export class RuntimeClientError extends Error {
  readonly code: RuntimeClientErrorCode;

  constructor(code: RuntimeClientErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RuntimeClientError";
    this.code = code;
  }
}

/** The runtime service is not listening, or its endpoint cannot be reached. */
export class RuntimeUnavailableError extends RuntimeClientError {
  readonly pipePath: string;

  constructor(pipePath: string, cause?: unknown) {
    super(
      "runtime_unavailable",
      `the Virealm runtime service is not reachable on ${pipePath}`,
      cause,
    );
    this.name = "RuntimeUnavailableError";
    this.pipePath = pipePath;
  }
}

/** The endpoint exists but connecting took longer than the configured budget. */
export class RuntimeConnectionTimeoutError extends RuntimeClientError {
  constructor(pipePath: string, timeoutMs: number) {
    super(
      "connection_timeout",
      `connecting to ${pipePath} timed out after ${String(timeoutMs)} ms`,
    );
    this.name = "RuntimeConnectionTimeoutError";
  }
}

/** A request was sent but no response arrived within the configured budget. */
export class RuntimeRequestTimeoutError extends RuntimeClientError {
  readonly requestId: string;
  readonly method: string;

  constructor(method: string, requestId: string, timeoutMs: number) {
    super(
      "request_timeout",
      `${method} (${requestId}) timed out after ${String(timeoutMs)} ms`,
    );
    this.name = "RuntimeRequestTimeoutError";
    this.requestId = requestId;
    this.method = method;
  }
}

/** The runtime endpoint closed while requests were outstanding. */
export class RuntimeDisconnectedError extends RuntimeClientError {
  constructor(message = "the runtime connection closed unexpectedly") {
    super("connection_closed", message);
    this.name = "RuntimeDisconnectedError";
  }
}

/** The peer sent a payload that violates `@virealm/contracts`. */
export class RuntimeProtocolViolationError extends RuntimeClientError {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super("protocol_violation", message);
    this.name = "RuntimeProtocolViolationError";
    this.issues = issues;
  }
}

/** The runtime rejected a well-formed request; `error` is the contract payload. */
export class RuntimeOperationError extends RuntimeClientError {
  readonly error: ContractError;

  constructor(error: ContractError) {
    super("runtime_error", `${error.code}: ${error.message}`);
    this.name = "RuntimeOperationError";
    this.error = error;
  }
}

/** The caller closed the client while requests were outstanding. */
export class RuntimeClientClosedError extends RuntimeClientError {
  constructor() {
    super("client_closed", "the runtime client is closed");
    this.name = "RuntimeClientClosedError";
  }
}

/** Starting a local runtime host failed. */
export class RuntimeHostStartError extends RuntimeClientError {
  constructor(message: string, cause?: unknown) {
    super("host_start_failed", message, cause);
    this.name = "RuntimeHostStartError";
  }
}

/** Type guard for structured client failures. */
export function isRuntimeClientError(
  value: unknown,
): value is RuntimeClientError {
  return value instanceof RuntimeClientError;
}
