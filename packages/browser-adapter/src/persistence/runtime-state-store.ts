import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RuntimeStateStorePort } from "../application/ports.js";
import { BrowserAdapterError } from "../domain/errors.js";
import type {
  BrowserEnvironmentState,
  PersistedRuntimeState,
} from "../domain/status.js";

const STATE_VERSION = 1;

interface StateFile {
  readonly version: number;
  readonly environments: Record<string, PersistedRuntimeState>;
}

/**
 * Persists only the handles needed to reconcile processes this adapter
 * started. Environment configuration belongs to the Environment Manager.
 */
export class JsonRuntimeStateStore implements RuntimeStateStorePort {
  readonly filePath: string;
  private cache: StateFile | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataRoot: string) {
    this.filePath = path.join(path.resolve(dataRoot), "runtime-state.json");
  }

  async read(
    environmentId: string,
  ): Promise<PersistedRuntimeState | undefined> {
    const file = await this.load();
    return file.environments[environmentId];
  }

  async list(): Promise<readonly PersistedRuntimeState[]> {
    const file = await this.load();
    return Object.values(file.environments);
  }

  async write(state: PersistedRuntimeState): Promise<void> {
    const operation = this.writeChain.then(async () => {
      const file = await this.load();
      const next: StateFile = {
        version: STATE_VERSION,
        environments: {
          ...file.environments,
          [state.environmentId]: state,
        },
      };
      await this.persist(next);
      this.cache = next;
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }

  private async load(): Promise<StateFile> {
    if (this.cache !== undefined) {
      return this.cache;
    }
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(content);
      this.cache = parseStateFile(parsed);
      return this.cache;
    } catch (error) {
      if (isNotFound(error)) {
        this.cache = { version: STATE_VERSION, environments: {} };
        return this.cache;
      }
      throw new BrowserAdapterError(
        "persistence_corrupted",
        "the adapter runtime state file is unreadable",
        { path: this.filePath },
        error,
      );
    }
  }

  private async persist(state: StateFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

function parseStateFile(value: unknown): StateFile {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== STATE_VERSION ||
    !("environments" in value) ||
    typeof value.environments !== "object" ||
    value.environments === null
  ) {
    throw new BrowserAdapterError(
      "persistence_corrupted",
      "the adapter runtime state file has an unsupported shape",
    );
  }

  const environments: Record<string, PersistedRuntimeState> = {};
  for (const [key, entry] of Object.entries(value.environments)) {
    environments[key] = parseStateEntry(entry);
  }
  return { version: STATE_VERSION, environments };
}

const STATES: ReadonlySet<BrowserEnvironmentState> = new Set([
  "stopped",
  "starting",
  "running",
  "stopping",
  "failed",
]);

function parseStateEntry(value: unknown): PersistedRuntimeState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("environmentId" in value) ||
    typeof value.environmentId !== "string" ||
    !("processInstanceId" in value) ||
    typeof value.processInstanceId !== "string" ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !("startedAtUnixMs" in value) ||
    typeof value.startedAtUnixMs !== "number" ||
    !("userDataDir" in value) ||
    typeof value.userDataDir !== "string" ||
    !("state" in value) ||
    typeof value.state !== "string" ||
    !STATES.has(value.state as BrowserEnvironmentState) ||
    !("updatedAtUnixMs" in value) ||
    typeof value.updatedAtUnixMs !== "number"
  ) {
    throw new BrowserAdapterError(
      "persistence_corrupted",
      "the adapter runtime state entry has an unsupported shape",
    );
  }

  return {
    environmentId: value.environmentId,
    processInstanceId: value.processInstanceId,
    pid: value.pid,
    startedAtUnixMs: value.startedAtUnixMs,
    userDataDir: value.userDataDir,
    endpoint: stringOrUndefined(value, "endpoint"),
    browserVersion: stringOrUndefined(value, "browserVersion"),
    state: value.state as BrowserEnvironmentState,
    updatedAtUnixMs: value.updatedAtUnixMs,
    lastError: lastErrorOrUndefined(value),
  };
}

function stringOrUndefined(value: object, key: string): string | undefined {
  if (!(key in value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function lastErrorOrUndefined(
  value: object,
): PersistedRuntimeState["lastError"] {
  if (!("lastError" in value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>).lastError;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "code" in candidate &&
    typeof candidate.code === "string" &&
    "message" in candidate &&
    typeof candidate.message === "string"
  ) {
    return { code: candidate.code, message: candidate.message };
  }
  return undefined;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
