import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  RuntimeClient,
  RuntimeClientClosedError,
  RuntimeConnectionTimeoutError,
  RuntimeDisconnectedError,
  RuntimeOperationError,
  RuntimeProtocolViolationError,
  RuntimeRequestTimeoutError,
  RuntimeUnavailableError,
} from "@virealm/runtime-client";

import type { LaunchParams } from "@virealm/contracts";
import {
  ProcessRuntimeClient,
  translateRuntimeError,
} from "../../src/runtime/process-runtime-client.js";
import {
  BrowserAdapterError,
  isBrowserAdapterError,
} from "../../src/domain/errors.js";

function missingEndpoint(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\virealm-missing-${randomUUID()}`
    : path.join(tmpdir(), `vr-${randomUUID().slice(0, 8)}.sock`);
}

const launchParams: LaunchParams = {
  environmentId: "env_a",
  executable: "C:\\Chrome\\chrome.exe",
  arguments: ["--user-data-dir=C:\\profile"],
  dataDirectory: "C:\\profile",
  policy: {
    isolation: "managed",
    allowedProgramRoots: ["C:\\Chrome"],
    fileAccess: { kind: "inherited" },
    networkAccess: "allow",
    containment: { killOnClose: true },
  },
};

describe("translateRuntimeError", () => {
  it("passes adapter errors through unchanged", () => {
    const original = new BrowserAdapterError("invalid_configuration", "bad");
    expect(translateRuntimeError("process.launch", original)).toBe(original);
  });

  it("preserves a runtime rejection code and retryability", () => {
    const translated = translateRuntimeError(
      "process.launch",
      new RuntimeOperationError({
        code: "capability_unavailable",
        message: "AppContainer is blocked",
        retryable: false,
        details: { operation: "CreateAppContainerProfile" },
      }),
    );
    expect(translated.code).toBe("runtime_operation_failed");
    expect(translated.details?.contractCode).toBe("capability_unavailable");
    expect(translated.details?.retryable).toBe(false);
    expect(translated.details?.contractDetails).toEqual({
      operation: "CreateAppContainerProfile",
    });
  });

  it.each([
    new RuntimeUnavailableError("\\\\.\\pipe\\virealm"),
    new RuntimeConnectionTimeoutError("\\\\.\\pipe\\virealm", 10),
  ])("maps %s to runtime_unavailable", (error) => {
    expect(translateRuntimeError("process.getStatus", error).code).toBe(
      "runtime_unavailable",
    );
  });

  it.each([
    new RuntimeRequestTimeoutError("process.launch", "req_1", 10),
    new RuntimeDisconnectedError(),
    new RuntimeClientClosedError(),
    new RuntimeProtocolViolationError("bad payload", ["x"]),
  ])("maps %s to runtime_ipc_failure", (error) => {
    expect(translateRuntimeError("process.launch", error).code).toBe(
      "runtime_ipc_failure",
    );
  });

  it("maps an unexpected error to internal_error", () => {
    const translated = translateRuntimeError(
      "runtime.getCapabilities",
      new Error("boom"),
    );
    expect(translated.code).toBe("internal_error");
    expect(translated.cause).toBeInstanceOf(Error);
  });
});

describe("ProcessRuntimeClient", () => {
  it("reports an unavailable runtime for every operation", async () => {
    const client = new ProcessRuntimeClient({
      pipePath: missingEndpoint(),
      connectTimeoutMs: 200,
      requestTimeoutMs: 200,
    });

    const operations: (() => Promise<unknown>)[] = [
      () => client.getCapabilities(),
      () => client.launch(launchParams),
      () => client.getStatus("1:1"),
      () => client.terminate("1:1"),
    ];
    for (const operation of operations) {
      try {
        await operation();
        throw new Error("expected the operation to fail");
      } catch (error) {
        expect(isBrowserAdapterError(error)).toBe(true);
        if (isBrowserAdapterError(error)) {
          expect(error.code).toBe("runtime_unavailable");
        }
      }
    }
    client.close();
  });

  it("wraps a client the caller already owns", async () => {
    const owned = new RuntimeClient({
      pipePath: missingEndpoint(),
      connectTimeoutMs: 200,
      requestTimeoutMs: 200,
    });
    const wrapper = new ProcessRuntimeClient(owned);

    try {
      await wrapper.getCapabilities();
      throw new Error("expected the operation to fail");
    } catch (error) {
      expect(isBrowserAdapterError(error)).toBe(true);
      if (isBrowserAdapterError(error)) {
        expect(error.code).toBe("runtime_unavailable");
      }
    }
    wrapper.close();
  });
});
