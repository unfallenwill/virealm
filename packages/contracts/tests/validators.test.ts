import { describe, expect, it } from "vitest";

import type { ContractError, ProcessStatus, Request } from "../src/index.js";
import {
  DEFAULT_RETRYABLE,
  ERROR_CODES,
  formatProcessInstanceId,
  isKnownMethod,
  isSupportedProtocolVersion,
  startedAtUnixMsFromCreationTime,
  unknownMethodError,
  unsupportedProtocolVersionError,
  validateCapabilityReport,
  validateError,
  validateEvent,
  validateProcessStatus,
  validateRequest,
  validateResponse,
} from "../src/index.js";
import { readFixture } from "./helpers/fixtures.js";

function validManagedStatus(): ProcessStatus {
  return {
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
}

function expectRejected(result: { ok: boolean }, label: string): void {
  expect(result.ok, `${label} should be rejected`).toBe(false);
}

describe("protocol constants", () => {
  it("recognises exactly the schema methods", () => {
    expect(isKnownMethod("process.launch")).toBe(true);
    expect(isKnownMethod("process.kill")).toBe(false);
    expect(isKnownMethod(42)).toBe(false);
  });

  it("requires an exact protocol version", () => {
    expect(isSupportedProtocolVersion(2)).toBe(true);
    expect(isSupportedProtocolVersion(1)).toBe(false);
    expect(isSupportedProtocolVersion("2")).toBe(false);
  });

  it("classifies every error code as retryable or not", () => {
    for (const code of ERROR_CODES) {
      expect(typeof DEFAULT_RETRYABLE[code]).toBe("boolean");
    }
  });
});

describe("request validation", () => {
  it("rejects non-object input without throwing", () => {
    for (const input of [null, undefined, 42, "request", []]) {
      expectRejected(validateRequest(input), String(input));
    }
  });

  it("reports a structured issue for an invalid field", () => {
    const request = {
      ...(readFixture("valid/request-get-capabilities.json") as Request),
      protocolVersion: 1,
    };
    const result = validateRequest(request);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: "/protocolVersion", keyword: "const" }),
    );
    const [first] = result.issues;
    expect(first?.message).toBeTypeOf("string");
    expect(first?.params).toBeTypeOf("object");
  });

  it("rejects an unknown method", () => {
    const result = validateRequest({
      protocolVersion: 2,
      requestId: "req_unknown_method_001",
      method: "process.kill",
    });
    expectRejected(result, "unknown method");
  });

  it("accepts a launch request that omits environment overrides", () => {
    const request = readFixture("valid/request-launch-managed.json") as Request;
    if (request.method !== "process.launch") {
      throw new Error("fixture method changed unexpectedly");
    }
    const params = { ...request.params };
    delete params.environmentOverrides;
    expect(validateRequest({ ...request, params }).ok).toBe(true);
  });

  it("rejects case-insensitive duplicate environment names", () => {
    const request = readFixture("valid/request-launch-managed.json") as Request;
    if (request.method !== "process.launch") {
      throw new Error("fixture method changed unexpectedly");
    }
    const result = validateRequest({
      ...request,
      params: {
        ...request.params,
        environmentOverrides: { PATH: "a", Path: "b" },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "/params/environmentOverrides",
        keyword: "contractSemantics",
      }),
    );
  });
});

describe("process status semantics", () => {
  it("accepts a consistent status", () => {
    const result = validateProcessStatus(validManagedStatus());
    expect(result).toEqual({ ok: true, value: validManagedStatus() });
  });

  it("rejects an instance id that does not encode pid and creation time", () => {
    const status = {
      ...validManagedStatus(),
      processInstanceId: "4243:134129088000000000",
    };
    const result = validateProcessStatus(status);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "/processInstanceId",
        keyword: "contractSemantics",
      }),
    );
  });

  it("rejects a running state whose PID differs from the identity", () => {
    const status = validManagedStatus();
    const result = validateProcessStatus({
      ...status,
      state: { state: "running", pid: 9999 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "/state/pid",
        keyword: "contractSemantics",
      }),
    );
  });

  it("rejects a start time that does not derive from the creation time", () => {
    const result = validateProcessStatus({
      ...validManagedStatus(),
      startedAtUnixMs: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "/startedAtUnixMs",
        keyword: "contractSemantics",
      }),
    );
  });

  it("derives identity and start time with exact integer arithmetic", () => {
    expect(formatProcessInstanceId(7, "9")).toBe("7:9");
    expect(startedAtUnixMsFromCreationTime("134129088000000000")).toBe(
      1_768_435_200_000,
    );
  });
});

describe("error validation", () => {
  it("accepts protocol-generated errors", () => {
    expect(validateError(unsupportedProtocolVersionError()).ok).toBe(true);
    expect(validateError(unknownMethodError("process.kill")).ok).toBe(true);
  });

  it("sanitises an unprintable unknown method into a valid error", () => {
    const error = unknownMethodError("process.kill\n");
    expect(error.message).toContain('"process.kill?"');
    expect(validateError(error).ok).toBe(true);
  });

  it("falls back for a method name that sanitises to nothing", () => {
    const error = unknownMethodError("");
    expect(error.details?.method).toBe("<unprintable>");
    expect(validateError(error).ok).toBe(true);
  });

  it("rejects details that do not belong to the code", () => {
    const cases: ContractError[] = [
      {
        code: "invalid_request",
        message: "bad",
        retryable: true,
        details: { method: "process.kill" },
      },
      {
        code: "invalid_request",
        message: "bad",
        retryable: true,
        details: { supportedProtocolVersion: 2 },
      },
      {
        code: "invalid_request",
        message: "bad",
        retryable: true,
        details: { windowsError: 5 },
      },
      {
        code: "platform_failure",
        message: "failed",
        retryable: false,
        details: { operation: "CreateProcessW" },
      },
    ];

    for (const error of cases) {
      expectRejected(validateError(error), JSON.stringify(error));
    }
  });

  it("rejects a retryability value that contradicts the protocol", () => {
    const result = validateError({
      ...unsupportedProtocolVersionError(),
      retryable: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        path: "/retryable",
        keyword: "contractSemantics",
      }),
    );
  });
});

describe("response, event and capability validation", () => {
  it("rejects a response whose error details are incomplete", () => {
    const response = readFixture(
      "valid/response-error-platform-failure.json",
    ) as {
      error: ContractError;
      [key: string]: unknown;
    };
    const result = validateResponse({
      ...response,
      error: { ...response.error, details: { operation: "CreateProcessW" } },
    });
    expectRejected(result, "platform failure without windowsError");
  });

  it("rejects an undefined event", () => {
    const result = validateEvent({
      protocolVersion: 2,
      eventId: "evt_unknown_001",
      event: "process.started",
      occurredAtUnixMs: 1,
      processInstanceId: "1:1",
      exitCode: 0,
    });
    expectRejected(result, "unknown event");
  });

  it("rejects a capability state outside the four-state model", () => {
    const report = readFixture("valid/capability-report.json") as {
      jobObject: unknown;
      [key: string]: unknown;
    };
    const result = validateCapabilityReport({
      ...report,
      jobObject: { state: "probably_supported" },
    });
    expectRejected(result, "unknown capability state");
  });
});
