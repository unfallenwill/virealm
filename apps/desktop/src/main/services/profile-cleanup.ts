import path from "node:path";
import { lstat, rm, rmdir } from "node:fs/promises";

import {
  ENVIRONMENT_ID_PATTERN,
  type EnvironmentRecord,
} from "../../shared/contracts.js";
import { DesktopError } from "../errors.js";

export interface ProfileCleanup {
  /** Throws unless the profile path is the exact managed directory. */
  assertSafe(
    record: EnvironmentRecord,
    userDataDir: string | undefined,
  ): Promise<void>;
  remove(
    record: EnvironmentRecord,
    userDataDir: string | undefined,
  ): Promise<void>;
}

export function expectedProfileDir(dataRoot: string, id: string): string {
  return path.join(path.resolve(dataRoot), "environments", id, "chrome-data");
}

/**
 * Deletes only `<dataRoot>/environments/<id>/chrome-data` after proving every
 * component is a real directory, not a link or an unrelated path.
 */
export class SafeProfileCleanup implements ProfileCleanup {
  constructor(private readonly dataRoot: string) {}

  async assertSafe(
    record: EnvironmentRecord,
    userDataDir: string | undefined,
  ): Promise<void> {
    const environmentId = record.id;
    if (!ENVIRONMENT_ID_PATTERN.test(environmentId)) {
      throw refused("环境 id 不合法，拒绝清理数据。");
    }
    const root = path.resolve(this.dataRoot);
    const environmentsRoot = path.join(root, "environments");
    const environmentRoot = path.join(environmentsRoot, environmentId);
    const expected = path.join(environmentRoot, "chrome-data");

    if (!isInside(environmentsRoot, expected)) {
      throw refused("数据目录不在受管理的根目录内，拒绝清理。");
    }
    if (path.resolve(record.dataDir) !== expected) {
      throw refused("记录中的数据目录与受管理目录不一致，拒绝清理。");
    }
    if (userDataDir !== undefined && path.resolve(userDataDir) !== expected) {
      throw refused("运行中的浏览器使用了不同的数据目录，拒绝清理。");
    }

    await assertPlainDirectory(environmentsRoot, true);
    await assertPlainDirectory(environmentRoot, true);
    await assertPlainDirectory(expected, true);
  }

  async remove(
    record: EnvironmentRecord,
    userDataDir: string | undefined,
  ): Promise<void> {
    await this.assertSafe(record, userDataDir);
    const environmentRoot = path.join(
      path.resolve(this.dataRoot),
      "environments",
      record.id,
    );
    const target = path.join(environmentRoot, "chrome-data");
    try {
      await rm(target, { recursive: true, force: false });
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw new DesktopError(
        "data_cleanup_failed",
        "删除浏览器数据目录失败。",
        { cause: error },
      );
    }
    // Remove the now-empty environment folder, never its parent.
    await rmdir(environmentRoot).catch(() => undefined);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

async function assertPlainDirectory(
  candidate: string,
  allowMissing: boolean,
): Promise<void> {
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if (allowMissing && isNotFound(error)) {
      return;
    }
    throw refused("无法检查数据目录，拒绝清理。");
  }
  if (info.isSymbolicLink()) {
    throw refused("数据目录是链接，拒绝清理。");
  }
  if (!info.isDirectory()) {
    throw refused("数据目录不是普通目录，拒绝清理。");
  }
}

function refused(message: string): DesktopError {
  return new DesktopError("data_cleanup_refused", message);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
