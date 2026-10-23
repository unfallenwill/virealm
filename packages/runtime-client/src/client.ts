import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

import {
  PROTOCOL_VERSION,
  validateRequest,
  validateResponse,
  type CapabilitiesResponse,
  type CapabilityReport,
  type DiagnosticsResponse,
  type LaunchParams,
  type LaunchResponse,
  type ProcessDiagnosticsResult,
  type ProcessStatus,
  type Request,
  type Response,
  type StatusResponse,
  type TerminateResponse,
} from "@virealm/contracts";

import {
  RuntimeClientClosedError,
  RuntimeConnectionTimeoutError,
  RuntimeDisconnectedError,
  RuntimeOperationError,
  RuntimeProtocolViolationError,
  RuntimeRequestTimeoutError,
  RuntimeUnavailableError,
  RuntimeClientError,
} from "./errors.js";

/** Default pipe created by `virealm-runtime serve`. */
export const DEFAULT_RUNTIME_PIPE_PATH = String.raw`\\.\pipe\virealm-runtime-v2`;

const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export interface RuntimeClientOptions {
  /** Full Windows pipe path. Defaults to the runtime's standard pipe. */
  readonly pipePath?: string;
  /** Budget for opening the pipe. */
  readonly connectTimeoutMs?: number;
  /** Budget for one request/response exchange. */
  readonly requestTimeoutMs?: number;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (response: Response) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

/**
 * Sequential-request client for the runtime's newline-delimited JSON protocol.
 *
 * One pipe connection is shared and re-opened on demand. Every outgoing and
 * incoming message is validated against `@virealm/contracts`; an invalid
 * response closes the connection instead of being interpreted loosely.
 */
export class RuntimeClient {
  readonly pipePath: string;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private socket: Socket | undefined;
  private connecting: Promise<void> | undefined;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(options: RuntimeClientOptions = {}) {
    this.pipePath = options.pipePath ?? DEFAULT_RUNTIME_PIPE_PATH;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  /** Whether a live pipe connection is currently open. */
  isConnected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  async getCapabilities(signal?: AbortSignal): Promise<CapabilityReport> {
    const requestId = newRequestId();
    return (
      await this.roundTrip<CapabilitiesResponse>(
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          method: "runtime.getCapabilities",
        },
        signal,
      )
    ).result;
  }

  async launch(
    params: LaunchParams,
    signal?: AbortSignal,
  ): Promise<ProcessStatus> {
    const requestId = newRequestId();
    return (
      await this.roundTrip<LaunchResponse>(
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          method: "process.launch",
          params,
        },
        signal,
      )
    ).result;
  }

  async getStatus(
    processInstanceId: string,
    signal?: AbortSignal,
  ): Promise<ProcessStatus> {
    const requestId = newRequestId();
    return (
      await this.roundTrip<StatusResponse>(
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          method: "process.getStatus",
          params: { processInstanceId },
        },
        signal,
      )
    ).result;
  }

  async terminate(
    processInstanceId: string,
    signal?: AbortSignal,
  ): Promise<ProcessStatus> {
    const requestId = newRequestId();
    return (
      await this.roundTrip<TerminateResponse>(
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          method: "process.terminate",
          params: { processInstanceId },
        },
        signal,
      )
    ).result;
  }

  async getDiagnostics(
    processInstanceId: string,
    signal?: AbortSignal,
  ): Promise<ProcessDiagnosticsResult> {
    const requestId = newRequestId();
    return (
      await this.roundTrip<DiagnosticsResponse>(
        {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          method: "process.getDiagnostics",
          params: { processInstanceId },
        },
        signal,
      )
    ).result;
  }

  /** Close the pipe and reject outstanding requests. Safe to call twice. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket?.destroy();
    this.socket = undefined;
    this.rejectAll(new RuntimeClientClosedError());
  }

  private async roundTrip<T extends Response>(
    request: Request,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) {
      throw new RuntimeClientClosedError();
    }
    if (signal?.aborted === true) {
      throw new RuntimeClientError(
        "request_aborted",
        `${request.method} was aborted before it was sent`,
      );
    }

    const validated = validateRequest(request);
    if (!validated.ok) {
      throw new RuntimeClientError(
        "invalid_request",
        `refusing to send an invalid ${request.method} request: ${validated.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`,
      );
    }

    await this.ensureConnected(signal);
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) {
      throw new RuntimeDisconnectedError();
    }

    const response = await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(
          new RuntimeRequestTimeoutError(
            request.method,
            request.requestId,
            this.requestTimeoutMs,
          ),
        );
      }, this.requestTimeoutMs);

      const onAbort =
        signal === undefined
          ? undefined
          : (): void => {
              this.pending.delete(request.requestId);
              clearTimeout(timer);
              reject(
                new RuntimeClientError(
                  "request_aborted",
                  `${request.method} was aborted while waiting for a response`,
                ),
              );
            };
      if (onAbort !== undefined) {
        signal?.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(request.requestId, {
        method: request.method,
        resolve,
        reject,
        timer,
        signal,
        onAbort,
      });

      const payload = `${JSON.stringify(validated.value)}\n`;
      socket.write(payload, "utf8", (error) => {
        if (error !== undefined && error !== null) {
          const pending = this.takePending(request.requestId);
          pending?.reject(
            new RuntimeDisconnectedError(
              `writing ${request.method} failed: ${error.message}`,
            ),
          );
        }
      });
    });

    if (!response.ok) {
      throw new RuntimeOperationError(response.error);
    }

    // The caller chose T for this request; the response was validated and its
    // request id and method match the request that produced it.
    return response as T;
  }

  private async ensureConnected(signal?: AbortSignal): Promise<void> {
    if (this.socket !== undefined && !this.socket.destroyed) {
      return;
    }
    if (this.connecting !== undefined) {
      await this.connecting;
      return;
    }

    const attempt = this.open(signal);
    this.connecting = attempt;
    try {
      await attempt;
    } finally {
      if (this.connecting === attempt) {
        this.connecting = undefined;
      }
    }
  }

  private async open(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = connect(this.pipePath);

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.off("error", onConnectError);
        if (error === undefined) {
          this.attach(socket);
          resolve();
        } else {
          socket.destroy();
          reject(error);
        }
      };

      const timer = setTimeout(() => {
        finish(
          new RuntimeConnectionTimeoutError(
            this.pipePath,
            this.connectTimeoutMs,
          ),
        );
      }, this.connectTimeoutMs);

      const onConnectError = (error: Error): void => {
        finish(new RuntimeUnavailableError(this.pipePath, error));
      };

      const onAbort = (): void => {
        finish(
          new RuntimeClientError(
            "request_aborted",
            "connection attempt was aborted",
          ),
        );
      };

      socket.once("connect", () => {
        finish();
      });
      socket.once("error", onConnectError);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      this.onData(chunk);
    });
    socket.on("error", (error: Error) => {
      this.handleDisconnect(
        new RuntimeDisconnectedError(
          `runtime connection failed: ${error.message}`,
        ),
      );
    });
    socket.on("end", () => {
      this.handleDisconnect(
        new RuntimeDisconnectedError("the runtime ended the connection"),
      );
    });
    socket.on("close", () => {
      this.handleDisconnect(new RuntimeDisconnectedError());
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline = this.buffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > 0) {
        this.onLine(line);
      }
      newline = this.buffer.indexOf(0x0a);
    }

    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.failConnection(
        new RuntimeProtocolViolationError(
          "runtime response exceeded the maximum message size",
        ),
      );
    }
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.failConnection(
        new RuntimeProtocolViolationError("runtime sent invalid JSON"),
      );
      return;
    }

    const validated = validateResponse(parsed);
    if (!validated.ok) {
      this.failConnection(
        new RuntimeProtocolViolationError(
          "runtime sent a response that violates the contract",
          validated.issues.map(
            (issue) => `${issue.path}: ${issue.keyword} ${issue.message}`,
          ),
        ),
      );
      return;
    }

    const response = validated.value;
    const requestId = response.requestId;
    if (requestId === undefined) {
      this.failConnection(
        new RuntimeProtocolViolationError(
          "runtime sent a response without a requestId",
        ),
      );
      return;
    }

    const pending = this.takePending(requestId);
    if (pending === undefined) {
      // A cancelled request can still produce a response; ignore it rather
      // than treating normal cancellation as a protocol violation.
      return;
    }

    if (response.ok && response.method !== pending.method) {
      pending.reject(
        new RuntimeProtocolViolationError(
          `response method ${response.method} does not match ${pending.method}`,
        ),
      );
      return;
    }
    pending.resolve(response);
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (pending === undefined) {
      return undefined;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.onAbort !== undefined) {
      pending.signal?.removeEventListener("abort", pending.onAbort);
    }
    return pending;
  }

  private handleDisconnect(error: Error): void {
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    this.rejectAll(error);
  }

  private failConnection(error: Error): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      if (request.onAbort !== undefined) {
        request.signal?.removeEventListener("abort", request.onAbort);
      }
      request.reject(error);
    }
  }
}

function newRequestId(): string {
  return `req_${randomUUID()}`;
}
