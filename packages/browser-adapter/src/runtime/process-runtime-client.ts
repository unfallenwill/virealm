import type {
  CapabilityReport,
  LaunchParams,
  ProcessStatus,
} from "@virealm/contracts";
import {
  RuntimeClientClosedError,
  RuntimeClientError,
  RuntimeConnectionTimeoutError,
  RuntimeDisconnectedError,
  RuntimeOperationError,
  RuntimeProtocolViolationError,
  RuntimeRequestTimeoutError,
  RuntimeUnavailableError,
  RuntimeClient,
  type RuntimeClientOptions,
} from "@virealm/runtime-client";

import type { RuntimePort } from "../application/ports.js";
import { BrowserAdapterError } from "../domain/errors.js";

/**
 * A runtime client the caller already owns, or the options for a new one.
 */
export type ProcessRuntimeClientSource = RuntimeClientOptions | RuntimeClient;

function isRuntimeClient(
  source: ProcessRuntimeClientSource,
): source is RuntimeClient {
  return typeof (source as RuntimeClient).launch === "function";
}

/**
 * Thin adapter over `@virealm/runtime-client`.
 *
 * It adds no queueing, retry or process logic of its own: it forwards calls
 * and translates transport failures into adapter error categories.
 */
export class ProcessRuntimeClient implements RuntimePort {
  private readonly client: RuntimeClient;

  constructor(source: ProcessRuntimeClientSource = {}) {
    this.client = isRuntimeClient(source) ? source : new RuntimeClient(source);
  }

  getCapabilities(signal?: AbortSignal): Promise<CapabilityReport> {
    return this.guard(
      "runtime.getCapabilities",
      this.client.getCapabilities(signal),
    );
  }

  launch(params: LaunchParams, signal?: AbortSignal): Promise<ProcessStatus> {
    return this.guard("process.launch", this.client.launch(params, signal));
  }

  getStatus(
    processInstanceId: string,
    signal?: AbortSignal,
  ): Promise<ProcessStatus> {
    return this.guard(
      "process.getStatus",
      this.client.getStatus(processInstanceId, signal),
    );
  }

  terminate(
    processInstanceId: string,
    signal?: AbortSignal,
  ): Promise<ProcessStatus> {
    return this.guard(
      "process.terminate",
      this.client.terminate(processInstanceId, signal),
    );
  }

  close(): void {
    this.client.close();
  }

  private async guard<T>(operation: string, action: Promise<T>): Promise<T> {
    try {
      return await action;
    } catch (error) {
      throw translateRuntimeError(operation, error);
    }
  }
}

export function translateRuntimeError(
  operation: string,
  error: unknown,
): BrowserAdapterError {
  if (error instanceof BrowserAdapterError) {
    return error;
  }
  if (error instanceof RuntimeOperationError) {
    return new BrowserAdapterError(
      "runtime_operation_failed",
      `the process runtime rejected ${operation}: ${error.error.message}`,
      {
        operation,
        contractCode: error.error.code,
        retryable: error.error.retryable,
        contractDetails: error.error.details,
      },
      error,
    );
  }
  if (
    error instanceof RuntimeUnavailableError ||
    error instanceof RuntimeConnectionTimeoutError
  ) {
    return new BrowserAdapterError(
      "runtime_unavailable",
      `the process runtime is unavailable while calling ${operation}`,
      { operation, retryable: true },
      error,
    );
  }
  if (
    error instanceof RuntimeRequestTimeoutError ||
    error instanceof RuntimeDisconnectedError ||
    error instanceof RuntimeClientClosedError ||
    error instanceof RuntimeProtocolViolationError
  ) {
    return new BrowserAdapterError(
      "runtime_ipc_failure",
      `the process runtime connection failed during ${operation}`,
      { operation, retryable: true },
      error,
    );
  }
  if (error instanceof RuntimeClientError) {
    return new BrowserAdapterError(
      "runtime_ipc_failure",
      `the process runtime call ${operation} failed: ${error.code}`,
      { operation, retryable: error.code !== "invalid_request" },
      error,
    );
  }
  return new BrowserAdapterError(
    "internal_error",
    `unexpected error while calling ${operation}`,
    undefined,
    error,
  );
}
