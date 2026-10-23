import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidationResult } from "../../src/index.js";
import {
  validateCapabilityReport,
  validateError,
  validateEvent,
  validateProcessStatus,
  validateRequest,
  validateResponse,
} from "../../src/index.js";

export const FIXTURES_ROOT = fileURLToPath(
  new URL("../../fixtures/", import.meta.url),
);

export type FixtureKind =
  "request" | "response" | "event" | "capability" | "status" | "error";

export interface InvalidExpectation {
  readonly path: string;
  readonly keyword: string;
  readonly missingProperty?: string;
  readonly additionalProperty?: string;
}

export interface ValidFixture {
  readonly file: string;
  readonly kind: FixtureKind;
}

export interface InvalidFixture {
  readonly file: string;
  readonly kind: FixtureKind;
  readonly expect: InvalidExpectation;
}

export interface FixtureManifest {
  readonly valid: readonly ValidFixture[];
  readonly invalid: readonly InvalidFixture[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readFixture(relativePath: string): unknown {
  const parsed: unknown = JSON.parse(
    readFileSync(join(FIXTURES_ROOT, relativePath), "utf8"),
  );
  return parsed;
}

export function loadManifest(): FixtureManifest {
  const manifest = readFixture("manifest.json");
  if (!isRecord(manifest)) {
    throw new Error("fixtures/manifest.json does not have the expected shape");
  }

  const valid: unknown = manifest.valid;
  const invalid: unknown = manifest.invalid;
  if (!Array.isArray(valid) || !Array.isArray(invalid)) {
    throw new Error("fixtures/manifest.json does not have the expected shape");
  }

  return {
    valid: valid as ValidFixture[],
    invalid: invalid as InvalidFixture[],
  };
}

export function validateFixture(
  kind: FixtureKind,
  value: unknown,
): ValidationResult<unknown> {
  switch (kind) {
    case "request":
      return validateRequest(value);
    case "response":
      return validateResponse(value);
    case "event":
      return validateEvent(value);
    case "capability":
      return validateCapabilityReport(value);
    case "status":
      return validateProcessStatus(value);
    case "error":
      return validateError(value);
  }
}

export function issueMatches(
  issue: {
    readonly path: string;
    readonly keyword: string;
    readonly params: Readonly<Record<string, unknown>>;
  },
  expectation: InvalidExpectation,
): boolean {
  if (
    issue.path !== expectation.path ||
    issue.keyword !== expectation.keyword
  ) {
    return false;
  }
  if (
    expectation.missingProperty !== undefined &&
    issue.params.missingProperty !== expectation.missingProperty
  ) {
    return false;
  }
  if (
    expectation.additionalProperty !== undefined &&
    issue.params.additionalProperty !== expectation.additionalProperty
  ) {
    return false;
  }
  return true;
}
