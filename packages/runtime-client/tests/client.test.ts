import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, type ProcessStatus } from "@virealm/contracts";

import {
  DEFAULT_RUNTIME_PIPE_PATH,
  RuntimeClient,
  RuntimeClientClosedError,
  RuntimeDisconnectedError,
  RuntimeOperationError,
  RuntimeProtocolViolationError,
  RuntimeRequestTimeoutError,
  RuntimeUnavailableError,
  RuntimeConnectionTimeoutError,
  RuntimeHostStartError,
  RuntimeClientError,
  isRuntimeClientError,
} from "../src/index.js";

const windowsOnly = process.platform === "win32";

interface FakeRequest {
  readonly protocolVersion?: number;
  readonly requestId?: string;
  readonly method?: string;
  readonly params?: unknown;
}

type Handler = (request: FakeRequest, socket: Socket) => void;

interface FakeRuntime {
  readonly pipePath: string;
  readonly requests: FakeRequest[];
  close(): Promise<void>;
}

const servers: Server[] = [];
const clients: RuntimeClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function startFakeRuntime(handler: Handler): Promise<FakeRuntime> {
  const pipePath = String.raw`\\.\pipe\virealm-test-${randomUUID()}`;
  const requests: FakeRequest[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          const request = JSON.parse(line) as FakeRequest;
          requests.push(request);
          handler(request, socket);
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    pipePath,
    requests,
    close: (): Promise<void> =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

function makeClient(
  pipePath: string,
  overrides: { requestTimeoutMs?: number; connectTimeoutMs?: number } = {},
): RuntimeClient {
  const client = new RuntimeClient({ pipePath, ...overrides });
  clients.push(client);
  return client;
}

function reply(socket: Socket, request: FakeRequest, result: unknown): void {
  socket.write(
    `${JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      method: request.method,
      ok: true,
      result,
    })}\n`,
  );
}

function replyError(
  socket: Socket,
  request: FakeRequest,
  error: Record<string, unknown>,
): void {
  socket.write(
    `${JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      method: request.method,
      ok: false,
      error,
    })}\n`,
  );
}

const capabilityReport = {
  platform: {
    os: "windows",
    version: { major: 10, minor: 0, build: 22631 },
    architecture: "x86_64",
    elevated: false,
    integrityLevel: "medium",
  },
  jobObject: { state: "supported" },
  appContainer: { state: "supported" },
  appContainerAcl: { state: "supported" },
  restrictedToken: { state: "supported" },
  processMitigation: { state: "not_verified" },
  etw: { state: "not_verified" },
};

const processStatus: ProcessStatus = {
  processInstanceId: "4242:134129088000000000",
  pid: 4242,
  creationTime100ns: "134129088000000000",
  startedAtUnixMs: 1_768_435_200_000,
  state: { state: "running", pid: 4242 },
  applied: {
    mode: "managed",
    jobObjectAttached: true,
    appContainerToken: false,
    restrictedToken: false,
    lowIntegrity: false,
    fileAccessRestricted: false,
    networkAccess: "allow",
    networkCapabilitiesVerified: false,
  },
};

const launchParams = {
  environmentId: "env-a",
  executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  arguments: ["--user-data-dir=C:\\Virealm\\env-a"],
  dataDirectory: "C:\\Virealm\\env-a",
  policy: {
    isolation: "managed" as const,
    allowedProgramRoots: ["C:\\Program Files\\Google\\Chrome\\Application"],
    fileAccess: { kind: "inherited" as const },
    networkAccess: "allow" as const,
    containment: { killOnClose: true as const },
  },
};

describe.skipIf(!windowsOnly)("RuntimeClient", () => {
  it("sends a contract-valid request and returns the validated result", async () => {
    const runtime = await startFakeRuntime((request, socket) => {
      reply(socket, request, capabilityReport);
    });
    const client = makeClient(runtime.pipePath);

    const result = await client.getCapabilities();

    expect(result.jobObject.state).toBe("supported");
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(runtime.requests[0]?.method).toBe("runtime.getCapabilities");
    expect(runtime.requests[0]?.requestId).toMatch(/^req_/);
    expect(client.isConnected()).toBe(true);
  });

  it("passes launch parameters through without reshaping them", async () => {
    const runtime = await startFakeRuntime((request, socket) => {
      reply(socket, request, processStatus);
    });
    const client = makeClient(runtime.pipePath);

    const status = await client.launch(launchParams);

    expect(status.processInstanceId).toBe("4242:134129088000000000");
    expect(runtime.requests[0]?.params).toEqual(launchParams);
  });

  it("surfaces a runtime rejection as a typed operation error", async () => {
    const runtime = await startFakeRuntime((request, socket) => {
      replyError(socket, request, {
        code: "process_not_found",
        message: "no managed process with this instance id",
        retryable: true,
      });
    });
    const client = makeClient(runtime.pipePath);

    const failure = await client
      .getStatus("1:2")
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeOperationError);
    const operation = failure as RuntimeOperationError;
    expect(operation.error.code).toBe("process_not_found");
    expect(operation.error.retryable).toBe(true);
  });

  it("rejects an invalid local request before touching the pipe", async () => {
    const client = makeClient(
      String.raw`\\.\pipe\virealm-unused-${randomUUID()}`,
    );

    const failure = await client
      .launch({ ...launchParams, executable: "chrome.exe" })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeClientError);
    expect((failure as RuntimeClientError).code).toBe("invalid_request");
  });

  it("closes the connection when the runtime violates the contract", async () => {
    const runtime = await startFakeRuntime((_request, socket) => {
      socket.write('{"not":"a response"}\n');
    });
    const client = makeClient(runtime.pipePath);

    const failure = await client
      .getCapabilities()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeProtocolViolationError);
    expect(client.isConnected()).toBe(false);
  });

  it("rejects a response whose method does not match the request", async () => {
    const runtime = await startFakeRuntime((request, socket) => {
      socket.write(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          method: "process.getStatus",
          ok: true,
          result: processStatus,
        })}\n`,
      );
    });
    const client = makeClient(runtime.pipePath);

    const failure = await client
      .getCapabilities()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeProtocolViolationError);
  });

  it("times out a request that receives no response", async () => {
    const runtime = await startFakeRuntime(() => undefined);
    const client = makeClient(runtime.pipePath, { requestTimeoutMs: 100 });

    const failure = await client
      .getCapabilities()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeRequestTimeoutError);
    expect((failure as RuntimeRequestTimeoutError).requestId).toMatch(/^req_/);
  });

  it("rejects outstanding requests when the runtime disconnects", async () => {
    const runtime = await startFakeRuntime((_request, socket) => {
      socket.destroy();
    });
    const client = makeClient(runtime.pipePath);

    const failure = await client
      .getCapabilities()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeDisconnectedError);
  });

  it("reports an unavailable runtime instead of hanging", async () => {
    const client = makeClient(
      String.raw`\\.\pipe\virealm-missing-${randomUUID()}`,
      { connectTimeoutMs: 500 },
    );

    const failure = await client
      .getCapabilities()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeUnavailableError);
    expect(client.isConnected()).toBe(false);
  });

  it("honours an AbortSignal while waiting for a response", async () => {
    const runtime = await startFakeRuntime(() => undefined);
    const client = makeClient(runtime.pipePath);
    const controller = new AbortController();

    const pending = client.getCapabilities(controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 50);

    const failure = await pending
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeClientError);
    expect((failure as RuntimeClientError).code).toBe("request_aborted");
  });

  it("rejects pending requests when the client is closed", async () => {
    const runtime = await startFakeRuntime(() => undefined);
    const client = makeClient(runtime.pipePath);

    const pending = client.getCapabilities();
    setTimeout(() => {
      client.close();
    }, 50);

    const failure = await pending
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeClientClosedError);
    expect(() => {
      client.close();
    }).not.toThrow();
  });

  it("reconnects on the next request after a clean disconnect", async () => {
    let served = 0;
    const runtime = await startFakeRuntime((request, socket) => {
      served += 1;
      reply(socket, request, capabilityReport);
      if (served === 1) {
        setTimeout(() => {
          socket.end();
        }, 10);
      }
    });
    const client = makeClient(runtime.pipePath);

    await client.getCapabilities();
    // Let the server's FIN reach the client before reusing the connection.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = await client.getCapabilities();

    expect(second.platform.os).toBe("windows");
    expect(runtime.requests).toHaveLength(2);
  });

  it("returns status, terminate and diagnostics results", async () => {
    const runtime = await startFakeRuntime((request, socket) => {
      if (request.method === "process.getDiagnostics") {
        reply(socket, request, {
          processInstanceId: processStatus.processInstanceId,
          diagnostics: [],
        });
      } else {
        reply(socket, request, processStatus);
      }
    });
    const client = makeClient(runtime.pipePath);

    const status = await client.getStatus(processStatus.processInstanceId);
    const terminated = await client.terminate(processStatus.processInstanceId);
    const diagnostics = await client.getDiagnostics(
      processStatus.processInstanceId,
    );

    expect(status.pid).toBe(4242);
    expect(terminated.state.state).toBe("running");
    expect(diagnostics.diagnostics).toEqual([]);
    expect(runtime.requests.map((request) => request.method)).toEqual([
      "process.getStatus",
      "process.terminate",
      "process.getDiagnostics",
    ]);
  });

  it("refuses to reuse a closed client", async () => {
    const client = makeClient(
      String.raw`\\.\pipe\virealm-unused-${randomUUID()}`,
    );
    client.close();

    const failure = await client
      .getCapabilities()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeClientClosedError);
  });

  it("refuses a signal that was already aborted", async () => {
    const client = makeClient(
      String.raw`\\.\pipe\virealm-unused-${randomUUID()}`,
    );
    const controller = new AbortController();
    controller.abort();

    const failure = await client
      .getCapabilities(controller.signal)
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeClientError);
    expect((failure as RuntimeClientError).code).toBe("request_aborted");
  });

  it("shares one connection between concurrent requests", async () => {
    const runtime = await startFakeRuntime((request, socket) => {
      reply(socket, request, capabilityReport);
    });
    const client = makeClient(runtime.pipePath);

    const [first, second] = await Promise.all([
      client.getCapabilities(),
      client.getCapabilities(),
    ]);

    expect(first.platform.os).toBe("windows");
    expect(second.platform.os).toBe("windows");
    expect(runtime.requests).toHaveLength(2);
  });

  it("removes the abort listener when a request completes", async () => {
    const runtime = await startFakeRuntime((request, socket) => {
      reply(socket, request, capabilityReport);
    });
    const client = makeClient(runtime.pipePath);
    const controller = new AbortController();

    await client.getCapabilities(controller.signal);

    expect(controller.signal.aborted).toBe(false);
  });

  it("ignores a response that belongs to no outstanding request", async () => {
    const runtime = await startFakeRuntime((_request, socket) => {
      socket.write(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          requestId: "req_00000000-0000-0000-0000-000000000000",
          method: "runtime.getCapabilities",
          ok: true,
          result: capabilityReport,
        })}\n`,
      );
    });
    const client = makeClient(runtime.pipePath, { requestTimeoutMs: 100 });

    const failure = await client
      .getCapabilities()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeRequestTimeoutError);
  });

  it("closes the connection when a response has no requestId", async () => {
    const runtime = await startFakeRuntime((_request, socket) => {
      socket.write(
        `${JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          ok: false,
          error: {
            code: "internal",
            message: "unsolicited failure",
            retryable: false,
          },
        })}\n`,
      );
    });
    const client = makeClient(runtime.pipePath);

    const failure = await client
      .getCapabilities()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeProtocolViolationError);
  });

  it("closes the connection when a response exceeds the size limit", async () => {
    const runtime = await startFakeRuntime((_request, socket) => {
      socket.write(Buffer.alloc(8 * 1024 * 1024 + 1, 0x78));
    });
    const client = makeClient(runtime.pipePath);

    const failure = await client
      .getCapabilities()
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeProtocolViolationError);
  });

  it("defaults to the runtime's standard pipe", () => {
    const client = new RuntimeClient();
    clients.push(client);

    expect(client.pipePath).toBe(DEFAULT_RUNTIME_PIPE_PATH);
    expect(client.isConnected()).toBe(false);
  });

  it("skips empty lines between messages", async () => {
    const runtime = await startFakeRuntime((request, socket) => {
      socket.write("\n");
      reply(socket, request, capabilityReport);
    });
    const client = makeClient(runtime.pipePath);

    const result = await client.getCapabilities();

    expect(result.platform.os).toBe("windows");
  });

  it("rejects an abortable pending request when the client closes", async () => {
    const runtime = await startFakeRuntime(() => undefined);
    const client = makeClient(runtime.pipePath);
    const controller = new AbortController();

    const pending = client.getCapabilities(controller.signal);
    setTimeout(() => {
      client.close();
    }, 50);

    const failure = await pending
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeClientClosedError);
  });

  it("exposes every error category with a stable code", () => {
    const cases: [RuntimeClientError, string][] = [
      [
        new RuntimeConnectionTimeoutError("\\\\.\\pipe\\x", 5),
        "connection_timeout",
      ],
      [new RuntimeHostStartError("nope"), "host_start_failed"],
      [new RuntimeDisconnectedError(), "connection_closed"],
      [new RuntimeClientClosedError(), "client_closed"],
      [new RuntimeProtocolViolationError("bad"), "protocol_violation"],
    ];
    for (const [error, code] of cases) {
      expect(error.code).toBe(code);
      expect(isRuntimeClientError(error)).toBe(true);
    }
    expect(isRuntimeClientError(new Error("plain"))).toBe(false);
  });
});
