import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { RuntimeHostStartError } from "./errors.js";
import { DEFAULT_RUNTIME_PIPE_PATH } from "./client.js";

const STDERR_TAIL_BYTES = 8 * 1024;
const RETRY_DELAY_MS = 100;

export interface RuntimeHostOptions {
  /** Absolute path to `virealm-runtime.exe`. */
  readonly executablePath: string;
  /** Pipe the child should serve on. Defaults to the standard pipe. */
  readonly pipePath?: string;
  /** How long to wait for the pipe to accept connections. */
  readonly startupTimeoutMs?: number;
}

/**
 * Bootstraps a local `virealm-runtime serve` process for demos and tests.
 *
 * This launches the runtime daemon itself, never a browser: the adapter must
 * still ask the runtime to create every Chrome process. Production hosts are
 * expected to own the daemon lifecycle and start it outside this helper.
 */
export class RuntimeHost {
  readonly pipePath: string;
  readonly pid: number | undefined;
  private readonly child: ChildProcess;
  private stderr = "";
  private exited = false;

  private constructor(child: ChildProcess, pipePath: string) {
    this.child = child;
    this.pipePath = pipePath;
    this.pid = child.pid;
    child.once("exit", () => {
      this.exited = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(
        -STDERR_TAIL_BYTES,
      );
    });
  }

  static async start(options: RuntimeHostOptions): Promise<RuntimeHost> {
    if (!existsSync(options.executablePath)) {
      throw new RuntimeHostStartError(
        `runtime executable does not exist: ${options.executablePath}`,
      );
    }

    const pipePath = options.pipePath ?? DEFAULT_RUNTIME_PIPE_PATH;
    const child = spawn(options.executablePath, ["serve", "--pipe", pipePath], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    const host = new RuntimeHost(child, pipePath);
    const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;

    try {
      await host.waitUntilReady(startupTimeoutMs);
    } catch (error) {
      await host.stop();
      throw new RuntimeHostStartError(
        `runtime host failed to start on ${pipePath}: ${host.diagnostics()}`,
        error,
      );
    }
    return host;
  }

  /** Recent stderr from the daemon, for test diagnostics. */
  diagnostics(): string {
    const trimmed = this.stderr.trim();
    return trimmed.length > 0 ? trimmed : "(no stderr output)";
  }

  async stop(): Promise<void> {
    if (this.exited) {
      return;
    }
    this.child.kill();
    if (await this.waitForExit(5_000)) {
      return;
    }
    this.child.kill("SIGKILL");
    await this.waitForExit(2_000);
  }

  private async waitUntilReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited) {
        throw new RuntimeHostStartError(
          `runtime exited before serving: ${this.diagnostics()}`,
        );
      }
      if (await canConnect(this.pipePath)) {
        return;
      }
      await delay(RETRY_DELAY_MS);
    }
    throw new RuntimeHostStartError(
      `runtime did not open ${this.pipePath} within ${String(timeoutMs)} ms`,
    );
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited) {
        return true;
      }
      await delay(RETRY_DELAY_MS);
    }
    return this.exited;
  }
}

async function canConnect(pipePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(pipePath);
    const finish = (connected: boolean): void => {
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
  });
}
