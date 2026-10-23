import path from "node:path";

import type {
  AppSettingsView,
  ThemePreference,
} from "../../shared/contracts.js";
import type { SettingsPatch } from "../../shared/validation.js";
import { DesktopError } from "../errors.js";
import {
  nodeFileOperations,
  type FileOperations,
} from "./environment-store.js";

const SETTINGS_VERSION = 1;

interface SettingsFile {
  readonly version: number;
  readonly theme: ThemePreference;
  readonly defaultBrowserPath?: string;
}

export interface SettingsStore {
  get(): Promise<AppSettingsView>;
  update(patch: SettingsPatch): Promise<AppSettingsView>;
  warning(): string | undefined;
}

const DEFAULTS: SettingsFile = {
  version: SETTINGS_VERSION,
  theme: "dark",
};

/**
 * Small versioned JSON file for desktop preferences.
 *
 * A failed write leaves the previous file intact; an unreadable file is
 * renamed to a backup before defaults are used, never silently overwritten.
 */
export class JsonSettingsStore implements SettingsStore {
  private cache: SettingsFile | undefined;
  private storeWarning: string | undefined;
  private chain: Promise<void> = Promise.resolve();
  private counter = 0;

  constructor(
    private readonly filePath: string,
    private readonly operations: FileOperations = nodeFileOperations,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<AppSettingsView> {
    return toView(await this.load());
  }

  update(patch: SettingsPatch): Promise<AppSettingsView> {
    const operation = this.chain.then(async () => {
      const current = await this.load();
      const browserPath =
        "defaultBrowserPath" in patch
          ? patch.defaultBrowserPath
          : current.defaultBrowserPath;
      const next: SettingsFile = {
        version: SETTINGS_VERSION,
        theme: patch.theme ?? current.theme,
        ...(browserPath === undefined
          ? {}
          : { defaultBrowserPath: browserPath }),
      };
      await this.persist(next);
      this.cache = next;
      return toView(next);
    });
    this.chain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  warning(): string | undefined {
    return this.storeWarning;
  }

  private async load(): Promise<SettingsFile> {
    if (this.cache !== undefined) {
      return this.cache;
    }
    let content: string;
    try {
      content = await this.operations.readFile(this.filePath);
    } catch (error) {
      if (isNotFound(error)) {
        this.cache = DEFAULTS;
        return this.cache;
      }
      throw new DesktopError("persistence_failed", "无法读取应用设置。", {
        cause: error,
      });
    }
    const parsed = parseSettings(content);
    if (parsed === undefined) {
      const backup = `${this.filePath}.corrupt-${String(this.now())}.bak`;
      try {
        await this.operations.rename(this.filePath, backup);
        this.storeWarning = `应用设置文件无效，已备份到 ${backup}，并使用默认设置。`;
      } catch {
        this.storeWarning = "应用设置文件无效，且无法备份；本次使用默认设置。";
      }
      this.cache = DEFAULTS;
      return this.cache;
    }
    this.cache = parsed;
    return parsed;
  }

  private async persist(file: SettingsFile): Promise<void> {
    this.counter += 1;
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.${String(process.pid)}.${String(this.counter)}.tmp`;
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
        "保存应用设置失败，原有设置未被修改。",
        { cause: error },
      );
    }
  }
}

function parseSettings(content: string): SettingsFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== SETTINGS_VERSION) {
    return undefined;
  }
  const theme = record.theme;
  if (theme !== "dark" && theme !== "light" && theme !== "system") {
    return undefined;
  }
  const defaultBrowserPath = record.defaultBrowserPath;
  if (
    defaultBrowserPath !== undefined &&
    (typeof defaultBrowserPath !== "string" ||
      defaultBrowserPath.length === 0 ||
      defaultBrowserPath.length > 4096)
  ) {
    return undefined;
  }
  return {
    version: SETTINGS_VERSION,
    theme,
    ...(defaultBrowserPath === undefined ? {} : { defaultBrowserPath }),
  };
}

function toView(file: SettingsFile): AppSettingsView {
  return {
    theme: file.theme,
    defaultBrowserPath: file.defaultBrowserPath,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
