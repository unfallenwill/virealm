import path from "node:path";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";

import {
  ENVIRONMENT_ID_PATTERN,
  type EnvironmentRecord,
  type LaunchRecord,
} from "../../shared/contracts.js";
import { parseEnvironmentDraft } from "../../shared/validation.js";
import { DesktopError } from "../errors.js";

const STORE_VERSION = 1;

export interface StoreWarning {
  readonly code: "persistence_recovered" | "persistence_incompatible";
  readonly message: string;
  readonly backupPath: string | undefined;
}

export interface EnvironmentStore {
  list(): Promise<readonly EnvironmentRecord[]>;
  get(id: string): Promise<EnvironmentRecord | undefined>;
  create(record: EnvironmentRecord): Promise<void>;
  update(record: EnvironmentRecord): Promise<void>;
  remove(id: string): Promise<void>;
  warning(): StoreWarning | undefined;
}

/** Filesystem surface used by the store; injectable so failures are testable. */
export interface FileOperations {
  readFile(filePath: string): Promise<string>;
  mkdir(directory: string): Promise<void>;
  writeDurable(filePath: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export const nodeFileOperations: FileOperations = {
  readFile: (filePath) => readFile(filePath, "utf8"),
  mkdir: async (directory) => {
    await mkdir(directory, { recursive: true });
  },
  writeDurable: async (filePath, content) => {
    const handle = await open(filePath, "w");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename,
  unlink,
};

interface StoreFile {
  readonly version: number;
  readonly environments: readonly EnvironmentRecord[];
}

/**
 * Versioned, atomically written JSON registry owned by the desktop.
 *
 * This is not the adapter's runtime-state file: that one holds process handles
 * and is never used to decide which environments exist or what they want.
 */
export class JsonEnvironmentStore implements EnvironmentStore {
  readonly filePath: string;
  private cache: StoreFile | undefined;
  private storeWarning: StoreWarning | undefined;
  private readOnly = false;
  private chain: Promise<void> = Promise.resolve();
  private tempCounter = 0;

  constructor(
    filePath: string,
    private readonly operations: FileOperations = nodeFileOperations,
    private readonly now: () => number = Date.now,
  ) {
    this.filePath = path.resolve(filePath);
  }

  async list(): Promise<readonly EnvironmentRecord[]> {
    const file = await this.load();
    return [...file.environments].sort(
      (left, right) => left.createdAtUnixMs - right.createdAtUnixMs,
    );
  }

  async get(id: string): Promise<EnvironmentRecord | undefined> {
    const file = await this.load();
    return file.environments.find((entry) => entry.id === id);
  }

  create(record: EnvironmentRecord): Promise<void> {
    return this.mutate((entries) => {
      if (entries.some((entry) => entry.id === record.id)) {
        throw new DesktopError(
          "environment_exists",
          "an environment with this id already exists",
          { details: { environmentId: record.id } },
        );
      }
      return [...entries, record];
    });
  }

  update(record: EnvironmentRecord): Promise<void> {
    return this.mutate((entries) => {
      const index = entries.findIndex((entry) => entry.id === record.id);
      if (index < 0) {
        throw new DesktopError(
          "environment_not_found",
          "the environment does not exist",
          { details: { environmentId: record.id } },
        );
      }
      const copy = [...entries];
      copy[index] = record;
      return copy;
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate((entries) => {
      const next = entries.filter((entry) => entry.id !== id);
      if (next.length === entries.length) {
        throw new DesktopError(
          "environment_not_found",
          "the environment does not exist",
          { details: { environmentId: id } },
        );
      }
      return next;
    });
  }

  warning(): StoreWarning | undefined {
    return this.storeWarning;
  }

  private mutate(
    change: (entries: readonly EnvironmentRecord[]) => EnvironmentRecord[],
  ): Promise<void> {
    const operation = this.chain.then(async () => {
      const file = await this.load();
      if (this.readOnly) {
        throw new DesktopError(
          "persistence_incompatible",
          "环境列表由更高版本的 Virealm 写入，当前版本不会覆盖它。",
        );
      }
      const next: StoreFile = {
        version: STORE_VERSION,
        environments: change(file.environments),
      };
      await this.persist(next);
      this.cache = next;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  private async load(): Promise<StoreFile> {
    if (this.cache !== undefined) {
      return this.cache;
    }
    let content: string;
    try {
      content = await this.operations.readFile(this.filePath);
    } catch (error) {
      if (isNotFound(error)) {
        this.cache = { version: STORE_VERSION, environments: [] };
        return this.cache;
      }
      throw new DesktopError("persistence_failed", "无法读取环境列表文件。", {
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return this.recoverCorrupted("环境列表文件不是有效的 JSON。");
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      typeof parsed.version !== "number"
    ) {
      return this.recoverCorrupted("环境列表文件缺少版本信息。");
    }
    if (parsed.version !== STORE_VERSION) {
      this.readOnly = true;
      this.storeWarning = {
        code: "persistence_incompatible",
        message: `环境列表版本为 ${String(parsed.version)}，当前应用只支持版本 ${String(STORE_VERSION)}。为保护数据，应用不会写入该文件。`,
        backupPath: undefined,
      };
      this.cache = { version: STORE_VERSION, environments: [] };
      return this.cache;
    }

    const environments: EnvironmentRecord[] = [];
    const raw = "environments" in parsed ? parsed.environments : undefined;
    if (!Array.isArray(raw)) {
      return this.recoverCorrupted("环境列表结构无效。");
    }
    const seen = new Set<string>();
    for (const [index, entry] of raw.entries()) {
      const record = parseRecord(entry);
      if (record === undefined || seen.has(record.id)) {
        return this.recoverCorrupted(
          `环境列表中第 ${String(index + 1)} 条记录无效或重复。`,
        );
      }
      seen.add(record.id);
      environments.push(record);
    }

    this.cache = { version: STORE_VERSION, environments };
    return this.cache;
  }

  private async recoverCorrupted(message: string): Promise<StoreFile> {
    const backupPath = `${this.filePath}.corrupt-${String(this.now())}.bak`;
    let backedUp = true;
    try {
      await this.operations.rename(this.filePath, backupPath);
    } catch {
      backedUp = false;
      this.readOnly = true;
    }
    this.storeWarning = {
      code: "persistence_recovered",
      message: backedUp
        ? `${message}原文件已备份，应用以空列表启动。`
        : `${message}原文件无法备份，为避免覆盖，应用暂时只读。`,
      backupPath: backedUp ? backupPath : undefined,
    };
    this.cache = { version: STORE_VERSION, environments: [] };
    return this.cache;
  }

  private async persist(file: StoreFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    this.tempCounter += 1;
    const temporary = `${this.filePath}.${String(process.pid)}.${String(this.tempCounter)}.tmp`;
    try {
      await this.operations.mkdir(directory);
      await this.operations.writeDurable(
        temporary,
        `${JSON.stringify(file, null, 2)}\n`,
      );
      await this.operations.rename(temporary, this.filePath);
    } catch (error) {
      await this.operations.unlink(temporary).catch(() => undefined);
      throw new DesktopError(
        "persistence_failed",
        "保存环境列表失败，原有数据未被修改。",
        { cause: error },
      );
    }
  }
}

function parseRecord(value: unknown): EnvironmentRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const draft = parseEnvironmentDraft({
    name: record.name,
    browser: record.browser,
    timezone: record.timezone,
    locale: record.locale,
    viewport: record.viewport,
    geolocation: record.geolocation,
    runtimePolicy: record.runtimePolicy,
    launch: record.launch,
  });
  if (!draft.ok) {
    return undefined;
  }
  if (
    typeof record.id !== "string" ||
    !ENVIRONMENT_ID_PATTERN.test(record.id) ||
    !isTimestamp(record.createdAtUnixMs) ||
    !isTimestamp(record.updatedAtUnixMs) ||
    typeof record.pendingRestart !== "boolean" ||
    typeof record.dataDir !== "string" ||
    !path.isAbsolute(record.dataDir)
  ) {
    return undefined;
  }
  const lastLaunch = parseLastLaunch(record.lastLaunch);
  if (record.lastLaunch !== undefined && lastLaunch === undefined) {
    return undefined;
  }
  return {
    ...draft.value,
    id: record.id,
    createdAtUnixMs: record.createdAtUnixMs,
    updatedAtUnixMs: record.updatedAtUnixMs,
    pendingRestart: record.pendingRestart,
    dataDir: record.dataDir,
    ...(lastLaunch === undefined ? {} : { lastLaunch }),
  };
}

function parseLastLaunch(value: unknown): LaunchRecord | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("atUnixMs" in value) ||
    typeof value.atUnixMs !== "number" ||
    !("ok" in value) ||
    typeof value.ok !== "boolean" ||
    !("message" in value) ||
    typeof value.message !== "string"
  ) {
    return undefined;
  }
  const code =
    "code" in value && typeof value.code === "string" ? value.code : undefined;
  return {
    atUnixMs: value.atUnixMs,
    ok: value.ok,
    message: value.message.slice(0, 500),
    ...(code === undefined ? {} : { code }),
  };
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
