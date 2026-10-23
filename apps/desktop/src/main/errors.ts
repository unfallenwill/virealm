import {
  isBrowserAdapterError,
  type BrowserAdapterErrorCode,
} from "@virealm/browser-adapter";

import type { IpcErrorView, ValidationIssueView } from "../shared/contracts.js";
import type { ValidationIssue } from "../shared/validation.js";
import { redactMessage } from "./logging.js";

export type DesktopErrorCode =
  | BrowserAdapterErrorCode
  | "invalid_request"
  | "environment_busy"
  | "environment_exists"
  | "environment_running"
  | "environment_not_running"
  | "environment_restart_required"
  | "data_cleanup_refused"
  | "data_cleanup_failed"
  | "persistence_failed"
  | "persistence_incompatible"
  | "runtime_not_started";

const SAFE_DETAIL_KEYS = new Set([
  "operation",
  "contractCode",
  "retryable",
  "environmentId",
  "expected",
  "actual",
  "state",
  "otherEnvironmentId",
]);

export class DesktopError extends Error {
  readonly code: DesktopErrorCode;
  readonly issues: readonly ValidationIssue[] | undefined;
  readonly details:
    Readonly<Record<string, string | number | boolean>> | undefined;

  constructor(
    code: DesktopErrorCode,
    message: string,
    options: {
      readonly issues?: readonly ValidationIssue[];
      readonly details?: Readonly<Record<string, string | number | boolean>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "DesktopError";
    this.code = code;
    this.issues = options.issues;
    this.details = options.details;
  }
}

/** Convert any failure to the renderer's structured, stack-free shape. */
export function toIpcError(error: unknown): IpcErrorView {
  if (error instanceof DesktopError) {
    return {
      code: error.code,
      message: redactMessage(error.message),
      ...(error.issues === undefined
        ? {}
        : { issues: error.issues.map(toIssueView) }),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (isBrowserAdapterError(error)) {
    const issues = adapterIssues(error.details);
    const details = sanitizeDetails(error.details);
    return {
      code: error.code,
      message: redactMessage(error.message),
      ...(issues === undefined ? {} : { issues }),
      ...(details === undefined ? {} : { details }),
    };
  }
  if (error instanceof Error) {
    return {
      code: "internal_error",
      message: "操作失败，内部错误详情已记录到诊断日志。",
    };
  }
  return {
    code: "internal_error",
    message: "操作失败，内部错误详情已记录到诊断日志。",
  };
}

export function toIssueView(issue: ValidationIssue): ValidationIssueView {
  return {
    path: issue.path,
    code: issue.code,
    message: redactMessage(issue.message),
  };
}

export function invalidRequest(
  message: string,
  issues: readonly ValidationIssue[],
): DesktopError {
  return new DesktopError("invalid_request", message, { issues });
}

function sanitizeDetails(
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string | number | boolean>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const selected: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      SAFE_DETAIL_KEYS.has(key) &&
      (typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean")
    ) {
      selected[key] = typeof entry === "string" ? redactMessage(entry) : entry;
    }
  }
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function adapterIssues(
  details: Readonly<Record<string, unknown>> | undefined,
): readonly ValidationIssueView[] | undefined {
  if (details === undefined) {
    return undefined;
  }
  const raw = details.issues;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const entries = raw as readonly unknown[];
  const issues: ValidationIssueView[] = [];
  for (const entry of entries.slice(0, 64)) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "path" in entry &&
      typeof entry.path === "string" &&
      "code" in entry &&
      typeof entry.code === "string" &&
      "message" in entry &&
      typeof entry.message === "string"
    ) {
      issues.push({
        path: entry.path,
        code: entry.code,
        message: redactMessage(entry.message),
      });
    }
  }
  return issues.length > 0 ? issues : undefined;
}
