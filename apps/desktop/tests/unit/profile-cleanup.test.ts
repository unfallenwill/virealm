import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EnvironmentRecord } from "../../src/shared/contracts.js";
import {
  SafeProfileCleanup,
  expectedProfileDir,
} from "../../src/main/services/profile-cleanup.js";
import { recordFor } from "./helpers/fakes.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "virealm-cleanup-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function record(id = "env-clean"): EnvironmentRecord {
  return {
    ...recordFor({ id }),
    dataDir: expectedProfileDir(root, id),
  };
}

async function createProfile(id = "env-clean"): Promise<string> {
  const profile = expectedProfileDir(root, id);
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "Cookies"), "data");
  return profile;
}

describe("expectedProfileDir", () => {
  it("uses the adapter's managed layout", () => {
    expect(expectedProfileDir("C:\\root", "env-1")).toBe(
      path.join("C:\\root", "environments", "env-1", "chrome-data"),
    );
  });
});

describe("SafeProfileCleanup", () => {
  it("removes only the managed profile and its empty parent", async () => {
    const cleanup = new SafeProfileCleanup(root);
    const profile = await createProfile();
    const sibling = await createProfile("env-keep");

    await cleanup.assertSafe(record(), profile);
    await cleanup.remove(record(), profile);

    await expect(
      rm(profile, { recursive: true, force: false }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stat(sibling)).toBeDefined();
    await expect(
      stat(path.join(root, "environments", "env-clean")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("tolerates a profile that never existed", async () => {
    const cleanup = new SafeProfileCleanup(root);
    await cleanup.assertSafe(record(), undefined);
    await cleanup.remove(record(), undefined);
    expect(await stat(root)).toBeDefined();
  });

  it("removes an existing empty profile root", async () => {
    const cleanup = new SafeProfileCleanup(root);
    const profile = expectedProfileDir(root, "env-clean");
    await mkdir(profile, { recursive: true });
    await cleanup.remove(record(), undefined);
    await expect(
      stat(path.join(root, "environments", "env-clean")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an invalid environment id", async () => {
    const cleanup = new SafeProfileCleanup(root);
    await expect(
      cleanup.assertSafe({ ...record(), id: "BAD" }, undefined),
    ).rejects.toMatchObject({ code: "data_cleanup_refused" });
  });

  it("refuses a record pointing outside the managed directory", async () => {
    const cleanup = new SafeProfileCleanup(root);
    await expect(
      cleanup.assertSafe(
        { ...record(), dataDir: path.join(root, "elsewhere") },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "data_cleanup_refused" });
  });

  it("refuses when the live browser uses another directory", async () => {
    const cleanup = new SafeProfileCleanup(root);
    await expect(
      cleanup.assertSafe(record(), path.join(root, "other-profile")),
    ).rejects.toMatchObject({ code: "data_cleanup_refused" });
  });

  it("refuses a profile path that is a regular file", async () => {
    const cleanup = new SafeProfileCleanup(root);
    const profile = expectedProfileDir(root, "env-clean");
    await mkdir(path.dirname(profile), { recursive: true });
    await writeFile(profile, "not a directory");
    await expect(cleanup.assertSafe(record(), undefined)).rejects.toMatchObject(
      { code: "data_cleanup_refused" },
    );
  });

  it("refuses a linked profile directory", async () => {
    const cleanup = new SafeProfileCleanup(root);
    const outside = await mkdtemp(path.join(tmpdir(), "virealm-outside-"));
    try {
      const profile = expectedProfileDir(root, "env-clean");
      await mkdir(path.dirname(profile), { recursive: true });
      await symlink(
        outside,
        profile,
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        cleanup.assertSafe(record(), undefined),
      ).rejects.toMatchObject({ code: "data_cleanup_refused" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a linked environment folder", async () => {
    const cleanup = new SafeProfileCleanup(root);
    const outside = await mkdtemp(path.join(tmpdir(), "virealm-outside-"));
    try {
      await mkdir(path.join(outside, "chrome-data"), { recursive: true });
      const environments = path.join(root, "environments");
      await mkdir(environments, { recursive: true });
      await symlink(
        outside,
        path.join(environments, "env-clean"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(
        cleanup.assertSafe(record(), undefined),
      ).rejects.toMatchObject({ code: "data_cleanup_refused" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses an environment path that is not a directory", async () => {
    const cleanup = new SafeProfileCleanup(root);
    const environmentRoot = path.join(root, "environments", "env-clean");
    await mkdir(path.dirname(environmentRoot), { recursive: true });
    await writeFile(environmentRoot, "file");
    await expect(cleanup.assertSafe(record(), undefined)).rejects.toMatchObject(
      { code: "data_cleanup_refused" },
    );
  });
});
