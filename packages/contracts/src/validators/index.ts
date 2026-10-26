import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

import type {
  CapabilityReport,
  ContractError,
  Event,
  ProcessStatus,
  Request,
  Response,
} from "../generated/protocol.js";
import { VIREALM_SCHEMA_ID, virealmSchema } from "../generated/schemas.js";
import { DEFAULT_RETRYABLE } from "../protocol/errors.js";
import {
  formatProcessInstanceId,
  startedAtUnixMsFromCreationTime,
} from "../protocol/process-identity.js";

const MAX_UINT64 = 18_446_744_073_709_551_615n;

/** One reason a message was rejected. */
export interface ValidationIssue {
  /** JSON Pointer into the rejected value; `/` for the root value. */
  readonly path: string;
  /** JSON Schema keyword, or `contractSemantics` for a cross-field rule. */
  readonly keyword: string;
  readonly message: string;
  /** Scalar parameters reported by the schema validator. */
  readonly params: Readonly<Record<string, unknown>>;
}

/** Validation never throws for bad input; it returns either a typed value or issues. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: false,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
  validateFormats: false,
});

ajv.addSchema(virealmSchema, VIREALM_SCHEMA_ID);

function requireValidator(definitionName: string): ValidateFunction {
  const validator = ajv.getSchema(
    `${VIREALM_SCHEMA_ID}#/$defs/${definitionName}`,
  );
  if (validator === undefined) {
    throw new Error(
      `Generated contract schema is missing the "${definitionName}" definition.`,
    );
  }
  return validator;
}

const requestValidator = requireValidator("Request");
const responseValidator = requireValidator("Response");
const eventValidator = requireValidator("Event");
const capabilityReportValidator = requireValidator("CapabilityReport");
const processStatusValidator = requireValidator("ProcessStatus");
const contractErrorValidator = requireValidator("ContractError");

function copyScalarParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const copied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      copied[key] = value;
    }
  }
  return copied;
}

function toIssue(error: ErrorObject): ValidationIssue {
  return {
    path: error.instancePath === "" ? "/" : error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "value does not match the schema",
    params: copyScalarParams(error.params),
  };
}

function semanticIssue(path: string, message: string): ValidationIssue {
  return { path, keyword: "contractSemantics", message, params: {} };
}

type Semantics<T> = (value: T) => readonly ValidationIssue[];

function validate<T>(
  validator: ValidateFunction,
  input: unknown,
  semantics: Semantics<T>,
): ValidationResult<T> {
  if (!validator(input)) {
    return {
      ok: false,
      issues: (validator.errors ?? []).map((error) => toIssue(error)),
    };
  }

  // Safe after the schema validator accepted the value: every property has
  // been checked at runtime, and this assertion only names the result.
  const value = input as T;
  const issues = semantics(value);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value };
}

const noSemantics = (): readonly ValidationIssue[] => [];

function checkProcessStatus(status: ProcessStatus): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const expectedId = formatProcessInstanceId(
    status.pid,
    status.creationTime100ns,
  );
  if (status.processInstanceId !== expectedId) {
    issues.push(
      semanticIssue(
        "/processInstanceId",
        "processInstanceId must be '<pid>:<creationTime100ns>' for this process",
      ),
    );
  }

  const creationTime = BigInt(status.creationTime100ns);
  if (creationTime > MAX_UINT64) {
    issues.push(
      semanticIssue(
        "/creationTime100ns",
        "creationTime100ns exceeds the unsigned 64-bit range of the runtime",
      ),
    );
  } else if (
    status.startedAtUnixMs !==
    startedAtUnixMsFromCreationTime(status.creationTime100ns)
  ) {
    issues.push(
      semanticIssue(
        "/startedAtUnixMs",
        "startedAtUnixMs must equal floor(creationTime100ns / 10000) - 11644473600000",
      ),
    );
  }

  if (status.state.state === "running" && status.state.pid !== status.pid) {
    issues.push(
      semanticIssue(
        "/state/pid",
        "the running state PID must match the status PID",
      ),
    );
  }

  return issues;
}

function asciiFold(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function checkRequest(request: Request): readonly ValidationIssue[] {
  if (request.method !== "process.launch") {
    return [];
  }

  const overrides = request.params.environmentOverrides;
  if (overrides === undefined) {
    return [];
  }

  const issues: ValidationIssue[] = [];
  const seen = new Map<string, string>();
  for (const name of Object.keys(overrides)) {
    const folded = asciiFold(name);
    const previous = seen.get(folded);
    if (previous === undefined) {
      seen.set(folded, name);
    } else {
      issues.push(
        semanticIssue(
          "/params/environmentOverrides",
          `environment variable names are case-insensitive: "${previous}" and "${name}" collide`,
        ),
      );
    }
  }
  return issues;
}

function checkDetailPresence(
  error: ContractError,
  issues: ValidationIssue[],
): void {
  const details = error.details;

  if (error.code === "unsupported_protocol_version") {
    if (details?.supportedProtocolVersion === undefined) {
      issues.push(
        semanticIssue(
          "/details/supportedProtocolVersion",
          "unsupported_protocol_version must report the implemented protocol version",
        ),
      );
    }
  } else if (details?.supportedProtocolVersion !== undefined) {
    issues.push(
      semanticIssue(
        "/details/supportedProtocolVersion",
        "supportedProtocolVersion is only valid for unsupported_protocol_version",
      ),
    );
  }

  if (error.code === "unknown_method") {
    if (details?.method === undefined) {
      issues.push(
        semanticIssue(
          "/details/method",
          "unknown_method must report the rejected method name",
        ),
      );
    }
  } else if (details?.method !== undefined) {
    issues.push(
      semanticIssue(
        "/details/method",
        "method is only valid for unknown_method",
      ),
    );
  }

  const hasWindowsError = details?.windowsError !== undefined;
  const hasErrno = details?.errno !== undefined;

  if (error.code === "platform_failure") {
    if (details?.operation === undefined) {
      issues.push(
        semanticIssue(
          "/details/operation",
          "platform_failure must report the failing operation",
        ),
      );
    }
    if (!hasWindowsError && !hasErrno) {
      issues.push(
        semanticIssue(
          "/details/windowsError",
          "platform_failure must report exactly one of windowsError or errno",
        ),
      );
    } else if (hasWindowsError && hasErrno) {
      issues.push(
        semanticIssue(
          "/details",
          "platform_failure must report exactly one of windowsError or errno",
        ),
      );
    }
  } else if (details?.operation !== undefined || hasWindowsError || hasErrno) {
    issues.push(
      semanticIssue(
        "/details",
        "operation, windowsError and errno are only valid for platform_failure",
      ),
    );
  }
}

function checkError(error: ContractError): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  checkDetailPresence(error, issues);

  if (
    error.code === "unsupported_protocol_version" ||
    error.code === "unknown_method"
  ) {
    const expected = DEFAULT_RETRYABLE[error.code];
    if (error.retryable !== expected) {
      issues.push(
        semanticIssue(
          "/retryable",
          `retryable must be ${expected ? "true" : "false"} for ${error.code}`,
        ),
      );
    }
  }

  return issues;
}

function checkResponse(response: Response): readonly ValidationIssue[] {
  if (!response.ok) {
    return checkError(response.error);
  }

  switch (response.method) {
    case "process.launch":
    case "process.getStatus":
    case "process.terminate":
      return checkProcessStatus(response.result);
    default:
      return [];
  }
}

export function validateRequest(input: unknown): ValidationResult<Request> {
  return validate(requestValidator, input, checkRequest);
}

export function validateResponse(input: unknown): ValidationResult<Response> {
  return validate(responseValidator, input, checkResponse);
}

export function validateEvent(input: unknown): ValidationResult<Event> {
  return validate(eventValidator, input, noSemantics);
}

export function validateCapabilityReport(
  input: unknown,
): ValidationResult<CapabilityReport> {
  return validate(capabilityReportValidator, input, noSemantics);
}

export function validateProcessStatus(
  input: unknown,
): ValidationResult<ProcessStatus> {
  return validate(processStatusValidator, input, checkProcessStatus);
}

export function validateError(input: unknown): ValidationResult<ContractError> {
  return validate(contractErrorValidator, input, checkError);
}
