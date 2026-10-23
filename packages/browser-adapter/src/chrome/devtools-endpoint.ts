import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { BrowserAdapterError } from "../domain/errors.js";

export interface DevToolsEndpoint {
  /** Loopback port chosen by Chrome for this launch. */
  readonly port: number;
  /** Browser WebSocket path from `DevToolsActivePort`. */
  readonly wsPath: string;
  /** `ws://127.0.0.1:<port><wsPath>` */
  readonly endpoint: string;
}

export interface WaitForEndpointOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  /** Called while waiting; false means the Chrome process already exited. */
  readonly checkAlive?: () => Promise<AliveCheck>;
}

export interface AliveCheck {
  readonly alive: boolean;
  readonly detail?: string;
}

/**
 * Read Chrome's endpoint advertisement. The port is allocated per launch and
 * the WebSocket path is random, so there is no fixed, shared debug port.
 */
export function readDevToolsEndpoint(
  userDataDir: string,
): DevToolsEndpoint | undefined {
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  let content: string;
  try {
    content = readFileSync(portFile, "utf8");
  } catch {
    return undefined;
  }

  const [portLine, pathLine] = content.split(/\r?\n/);
  const port = Number(portLine?.trim());
  const wsPath = pathLine?.trim() ?? "";
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !wsPath.startsWith("/")
  ) {
    return undefined;
  }

  return {
    port,
    wsPath,
    endpoint: `ws://127.0.0.1:${String(port)}${wsPath}`,
  };
}

/** Wait for Chrome to publish a usable endpoint, without a fixed delay. */
export async function waitForDevToolsEndpoint(
  userDataDir: string,
  options: WaitForEndpointOptions,
): Promise<DevToolsEndpoint> {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + options.timeoutMs;
  let lastDetail: string | undefined;

  while (Date.now() < deadline) {
    const endpoint = readDevToolsEndpoint(userDataDir);
    if (endpoint !== undefined) {
      return endpoint;
    }

    if (options.checkAlive !== undefined) {
      const alive = await options.checkAlive();
      if (!alive.alive) {
        throw new BrowserAdapterError(
          "browser_exited",
          alive.detail ??
            "Chrome exited before publishing its debugging endpoint",
          { userDataDir },
        );
      }
      lastDetail = alive.detail;
    }

    await delay(pollIntervalMs);
  }

  throw new BrowserAdapterError(
    "cdp_timeout",
    "Chrome did not publish a debugging endpoint before the launch timeout",
    { userDataDir, timeoutMs: options.timeoutMs, detail: lastDetail },
  );
}

/**
 * Endpoint validation. Chrome is launched with
 * `--remote-debugging-address=127.0.0.1`; anything else is treated as a
 * configuration escape.
 */
export function assertLoopbackEndpoint(endpoint: DevToolsEndpoint): void {
  if (!endpoint.wsPath.startsWith("/devtools/browser/")) {
    throw new BrowserAdapterError(
      "invalid_configuration",
      "the Chrome debugging endpoint does not name a browser target",
      { port: endpoint.port },
    );
  }
}
