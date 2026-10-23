import { BrowserAdapterError } from "../domain/errors.js";
import type { ViewportConfig } from "../domain/environment.js";

/**
 * Switches the adapter reserves. Accepting them from configuration would let a
 * caller redirect the profile, expose the debug endpoint, or weaken Chrome's
 * security model; the adapter refuses instead of silently rewriting them.
 */
const RESERVED_SWITCHES: ReadonlySet<string> = new Set([
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-web-security",
  "--disable-site-isolation-trials",
  "--disable-features",
  "--user-data-dir",
  "--profile-directory",
  "--remote-debugging-port",
  "--remote-debugging-pipe",
  "--remote-debugging-address",
  "--remote-allow-origins",
  "--single-process",
  "--load-extension",
  "--lang",
  "--window-size",
  "--allow-running-insecure-content",
  "--ignore-certificate-errors",
]);

const MAX_ADDITIONAL_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 1024;

export interface ChromeLaunchInput {
  readonly userDataDir: string;
  readonly locale: string | undefined;
  readonly viewport: ViewportConfig | undefined;
  readonly initialUrls: readonly string[] | undefined;
  readonly additionalArguments: readonly string[] | undefined;
}

/** Reason an extra switch cannot be accepted, or `undefined` when safe. */
export function unsafeArgumentReason(argument: string): string | undefined {
  if (argument.length === 0) {
    return "empty argument";
  }
  if (argument.length > MAX_ARGUMENT_LENGTH) {
    return "argument is longer than 1024 characters";
  }
  // Control characters can split or terminate an argv element downstream.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000\r\n]/.test(argument)) {
    return "argument contains a control character";
  }
  if (!argument.startsWith("--")) {
    return "extra arguments must be Chrome switches starting with --";
  }
  const name = argument.split("=", 1)[0]?.toLowerCase() ?? argument;
  if (RESERVED_SWITCHES.has(name)) {
    return `${name} is managed by the adapter`;
  }
  return undefined;
}

export function assertSafeAdditionalArguments(
  argumentsList: readonly string[],
): void {
  if (argumentsList.length > MAX_ADDITIONAL_ARGUMENTS) {
    throw new BrowserAdapterError(
      "invalid_configuration",
      `at most ${String(MAX_ADDITIONAL_ARGUMENTS)} additional Chrome arguments are allowed`,
      { path: "launch.additionalArguments" },
    );
  }
  for (const argument of argumentsList) {
    const reason = unsafeArgumentReason(argument);
    if (reason !== undefined) {
      throw new BrowserAdapterError(
        "invalid_configuration",
        `refusing Chrome argument ${JSON.stringify(argument)}: ${reason}`,
        { path: "launch.additionalArguments" },
      );
    }
  }
}

/**
 * Build Chrome's argv. Arguments stay a list: nothing is concatenated into a
 * shell command line. Remote debugging uses an ephemeral port bound to
 * loopback, and the profile is always the dedicated directory.
 */
export function buildChromeArguments(input: ChromeLaunchInput): string[] {
  const additional = input.additionalArguments ?? [];
  assertSafeAdditionalArguments(additional);

  const urls =
    input.initialUrls !== undefined && input.initialUrls.length > 0
      ? [...input.initialUrls]
      : ["about:blank"];

  return [
    `--user-data-dir=${input.userDataDir}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    ...(input.locale === undefined ? [] : [`--lang=${input.locale}`]),
    ...(input.viewport === undefined
      ? []
      : [
          `--window-size=${String(input.viewport.width)},${String(input.viewport.height)}`,
        ]),
    ...additional,
    ...urls,
  ];
}

/** Defence in depth before a process is created. */
export function assertSafeLaunchArguments(
  argumentsList: readonly string[],
): void {
  for (const argument of argumentsList) {
    const name = argument.split("=", 1)[0]?.toLowerCase() ?? "";
    if (
      name === "--no-sandbox" ||
      name === "--disable-web-security" ||
      name === "--disable-setuid-sandbox"
    ) {
      throw new BrowserAdapterError(
        "internal_error",
        "the adapter attempted to launch Chrome with a forbidden security switch",
        { argument: name },
      );
    }
  }
}
