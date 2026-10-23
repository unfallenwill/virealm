import type { ContractError, ErrorCode } from "../generated/protocol.js";
import { PROTOCOL_VERSION } from "../generated/constants.js";

/**
 * Default safety classification for each error category.
 *
 * `retryable` means "repeating the identical request cannot add side effects",
 * not "the next attempt is likely to succeed". Runtime failures are false
 * because a failed launch may already have created platform state; a caller
 * that knows the specific operation is idempotent may override this and
 * should record why.
 */
export const DEFAULT_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  invalid_request: true,
  unsupported_protocol_version: true,
  unknown_method: true,
  policy_violation: true,
  capability_unavailable: false,
  platform_failure: false,
  process_not_found: true,
  unsupported: true,
  internal: false,
};

/**
 * Error for a request whose protocol version this runtime does not implement.
 * The response carries the version the runtime does implement so a caller can
 * fail with a precise message instead of retrying forever.
 */
export function unsupportedProtocolVersionError(): ContractError {
  return {
    code: "unsupported_protocol_version",
    message: `unsupported protocol version; this runtime implements version ${String(PROTOCOL_VERSION)}`,
    retryable: true,
    details: { supportedProtocolVersion: PROTOCOL_VERSION },
  };
}

/**
 * Error for a method name this protocol does not define.
 *
 * Untrusted input is reduced to printable ASCII, truncated to the wire limit
 * and quoted, so a control character cannot break log formatting or produce an
 * error payload that fails its own schema.
 */
export function unknownMethodError(method: string): ContractError {
  const printable =
    method.replace(/[^ -~]/g, "?").slice(0, 128) || "<unprintable>";
  return {
    code: "unknown_method",
    message: `unknown method ${JSON.stringify(printable)}`,
    retryable: true,
    details: { method: printable },
  };
}
