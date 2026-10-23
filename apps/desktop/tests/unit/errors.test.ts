import { BrowserAdapterError } from "@virealm/browser-adapter";
import { describe, expect, it } from "vitest";

import {
  DesktopError,
  invalidRequest,
  toIpcError,
  toIssueView,
} from "../../src/main/errors.js";

describe("DesktopError", () => {
  it("carries a code, issues and safe details", () => {
    const cause = new Error("cause");
    const error = new DesktopError("invalid_configuration", "bad", {
      cause,
      issues: [{ path: "name", code: "required", message: "name is required" }],
      details: { environmentId: "env-1" },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DesktopError");
    expect(error.cause).toBe(cause);
    expect(error.code).toBe("invalid_configuration");
    expect(error.issues).toHaveLength(1);
    expect(error.details).toEqual({ environmentId: "env-1" });
  });

  it("creates an invalid-request issue list", () => {
    const error = invalidRequest("bad", [
      { path: "id", code: "invalid_value", message: "bad id" },
    ]);
    expect(error.code).toBe("invalid_request");
    expect(error.issues).toEqual([
      { path: "id", code: "invalid_value", message: "bad id" },
    ]);
  });

  it("converts an issue view without extra fields", () => {
    expect(
      toIssueView({ path: "name", code: "required", message: "name" }),
    ).toEqual({ path: "name", code: "required", message: "name" });
  });
});

describe("toIpcError", () => {
  it("serialises desktop errors with issues and details", () => {
    const view = toIpcError(
      new DesktopError(
        "launch_failed",
        "wss://host/devtools/browser/secret failed",
        {
          issues: [{ path: "x", code: "y", message: "authorization: abc" }],
          details: { environmentId: "env-1", operation: "launch" },
        },
      ),
    );
    expect(view).toEqual({
      code: "launch_failed",
      message: "wss://host/devtools/browser/[redacted] failed",
      issues: [{ path: "x", code: "y", message: "authorization=[redacted]" }],
      details: { environmentId: "env-1", operation: "launch" },
    });
  });

  it("omits empty optional fields", () => {
    expect(toIpcError(new DesktopError("internal_error", "plain"))).toEqual({
      code: "internal_error",
      message: "plain",
    });
  });

  it("sanitises adapter errors and keeps structured issues", () => {
    const error = new BrowserAdapterError(
      "config_verification_failed",
      "profile C:\\secret cookie=abc",
      {
        environmentId: "env-1",
        operation: "verify",
        retryable: false,
        state: "running",
        expected: "Asia/Shanghai",
        actual: "UTC",
        otherEnvironmentId: "env-2",
        token: "do-not-leak",
        nested: { secret: true },
        issues: [
          {
            path: "timezone",
            code: "failed",
            message: "authorization: Bearer abc",
          },
          { path: 4, code: "failed", message: "bad" },
          "not an issue",
        ],
      },
    );
    const view = toIpcError(error);
    expect(view).toMatchObject({
      code: "config_verification_failed",
      issues: [
        {
          path: "timezone",
          code: "failed",
          message: "authorization=[redacted]",
        },
      ],
      details: {
        environmentId: "env-1",
        operation: "verify",
        retryable: false,
        state: "running",
        expected: "Asia/Shanghai",
        actual: "UTC",
        otherEnvironmentId: "env-2",
      },
    });
    expect(view.message).toContain("cookie=[redacted]");
    expect(JSON.stringify(view)).not.toContain("do-not-leak");
    expect(JSON.stringify(view)).not.toContain('"nested"');
  });

  it("caps adapter issues and ignores unsafe details", () => {
    const issues = Array.from({ length: 80 }, (_, index) => ({
      path: `field-${String(index)}`,
      code: "failed",
      message: "mismatch",
    }));
    const view = toIpcError(
      new BrowserAdapterError("launch_failed", "failed", {
        issues,
        token: "abc",
      }),
    );
    expect(view.issues).toHaveLength(64);
    expect(view.details).toBeUndefined();
  });

  it("omits adapter issues when details hold no array", () => {
    const view = toIpcError(
      new BrowserAdapterError("launch_failed", "failed", { issues: "no" }),
    );
    expect(view.issues).toBeUndefined();
    expect(view.details).toBeUndefined();
  });

  it("handles adapter errors without details", () => {
    const view = toIpcError(new BrowserAdapterError("launch_failed", "failed"));
    expect(view).toEqual({ code: "launch_failed", message: "failed" });
  });

  it.each([new Error("internal stack"), "string failure", 42, undefined])(
    "hides internal failures: %s",
    (error) => {
      expect(toIpcError(error)).toEqual({
        code: "internal_error",
        message: "操作失败，内部错误详情已记录到诊断日志。",
      });
    },
  );

  it("redacts secrets in adapter detail values", () => {
    const view = toIpcError(
      new BrowserAdapterError("runtime_operation_failed", "failed", {
        operation: "authorization: abc",
      }),
    );
    expect(view.details).toEqual({ operation: "authorization=[redacted]" });
  });
});
