import type { ProtocolVersion } from "../generated/protocol.js";
import { METHOD_NAMES, PROTOCOL_VERSION } from "../generated/constants.js";

/**
 * Union of every method name, derived from the same schema enum the runtime
 * lists. There is no second hand-maintained list.
 */
export type MethodName = (typeof METHOD_NAMES)[number];

export {
  CAPABILITY_STATES,
  DIAGNOSTIC_LEVELS,
  ERROR_CODES,
  EVENT_NAMES,
  INTEGRITY_LEVELS,
  ISOLATION_MODES,
  METHOD_NAMES,
  NETWORK_ACCESS_VALUES,
  PROTOCOL_VERSION,
} from "../generated/constants.js";

/**
 * Exact-match version check. The protocol does not negotiate versions and has
 * no minor versions: a runtime accepts only the version it implements.
 */
export function isSupportedProtocolVersion(
  value: unknown,
): value is ProtocolVersion {
  return value === PROTOCOL_VERSION;
}

/**
 * Whether a value names one of the methods this protocol defines. A string
 * outside this list must produce an `unknown_method` error rather than being
 * dispatched to a default handler.
 */
export function isKnownMethod(value: unknown): value is MethodName {
  return (
    typeof value === "string" &&
    METHOD_NAMES.some((methodName) => methodName === value)
  );
}
