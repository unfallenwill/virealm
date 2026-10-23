/**
 * Conversion between Windows FILETIME values and the protocol's process
 * identity.
 *
 * The runtime exposes `u64` creation times. They are carried as decimal strings
 * because values around the current date (about 1.3e17) exceed JavaScript's
 * safe integer range. The helpers accept the schema-validated decimal string.
 */

const FILETIME_TICKS_PER_MILLISECOND = 10_000n;
const FILETIME_UNIX_EPOCH_OFFSET_MS = 11_644_473_600_000;

/** Build the durable identity used by every process message. */
export function formatProcessInstanceId(
  pid: number,
  creationTime100ns: string,
): string {
  return `${String(pid)}:${creationTime100ns}`;
}

/**
 * Convert a FILETIME creation time to Unix epoch milliseconds, rounding down
 * to the millisecond exactly as the schema description states.
 */
export function startedAtUnixMsFromCreationTime(
  creationTime100ns: string,
): number {
  const milliseconds =
    BigInt(creationTime100ns) / FILETIME_TICKS_PER_MILLISECOND;
  return Number(milliseconds) - FILETIME_UNIX_EPOCH_OFFSET_MS;
}
