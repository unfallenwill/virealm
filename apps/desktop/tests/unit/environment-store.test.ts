import path from "node:path";

import { describe, expect, it } from "vitest";

import { DesktopError } from "../../src/main/errors.js";
import { JsonEnvironmentStore } from "../../src/main/persistence/environment-store.js";
import { TEST_DATA_ROOT, MemoryFiles, recordFor } from "./helpers/fakes.js";

const FILE = path.join(TEST_DATA_ROOT, "environments.json");

function storeWith(files: MemoryFiles, now = 42): JsonEnvironmentStore {
  return new JsonEnvironmentStore(FILE, files, () => now);
}

function validFile(environments: readonly unknown[]): string {
  return JSON.stringify({ version: 1, environments }, null, 2);
}

describe("JsonEnvironmentStore", () => {
  it("starts empty when the file does not exist", async () => {
    const store = storeWith(new MemoryFiles());
    expect(await store.list()).toEqual([]);
    expect(await store.get("env-x")).toBeUndefined();
    expect(store.warning()).toBeUndefined();
  });

  it("persists records atomically and sorts by creation time", async () => {
    const files = new MemoryFiles();
    const store = storeWith(files);
    const later = recordFor({ id: "env-later", createdAt: 2_000 });
    const earlier = recordFor({ id: "env-earlier", createdAt: 1_000 });

    await store.create(later);
    await store.create(earlier);

    expect((await store.list()).map((record) => record.id)).toEqual([
      "env-earlier",
      "env-later",
    ]);
    expect(await store.get("env-later")).toEqual(later);
    const persisted = JSON.parse(files.files.get(FILE) ?? "{}") as unknown;
    expect(persisted).toMatchObject({ version: 1 });
    expect(files.writes).toHaveLength(2);
    expect(files.writes[0]).not.toBe(FILE);
    expect(files.writes[0]).toMatch(/\.tmp$/u);
  });

  it("updates and removes existing records", async () => {
    const store = storeWith(new MemoryFiles());
    await store.create(recordFor());
    const changed = {
      ...recordFor(),
      name: "重命名",
      updatedAtUnixMs: 2_000,
      pendingRestart: true,
    };
    await store.update(changed);
    expect(await store.get("env-test")).toEqual(changed);

    await store.remove("env-test");
    expect(await store.list()).toEqual([]);
  });

  it("rejects duplicate creates and missing updates or removals", async () => {
    const store = storeWith(new MemoryFiles());
    await store.create(recordFor());

    await expect(store.create(recordFor())).rejects.toMatchObject({
      code: "environment_exists",
    });
    await expect(
      store.update(recordFor({ id: "env-missing" })),
    ).rejects.toMatchObject({ code: "environment_not_found" });
    await expect(store.remove("env-missing")).rejects.toMatchObject({
      code: "environment_not_found",
    });
  });

  it("serialises concurrent mutations without losing records", async () => {
    const store = storeWith(new MemoryFiles());
    await Promise.all([
      store.create(recordFor({ id: "env-a" })),
      store.create(recordFor({ id: "env-b" })),
    ]);
    expect((await store.list()).map((record) => record.id)).toEqual([
      "env-a",
      "env-b",
    ]);
  });

  it.each([
    ["not json", "环境列表文件不是有效的 JSON。"],
    ["[]", "环境列表文件缺少版本信息。"],
    ["{}", "环境列表文件缺少版本信息。"],
    ['{"version":1}', "环境列表结构无效。"],
    [
      '{"version":1,"environments":[{"id":"env-x"}]}',
      "第 1 条记录无效或重复。",
    ],
    [
      validFile([recordFor({ id: "env-a" }), recordFor({ id: "env-a" })]),
      "第 2 条记录无效或重复。",
    ],
    [
      validFile([{ ...recordFor(), dataDir: "relative\\data" }]),
      "第 1 条记录无效或重复。",
    ],
  ])("backs up corrupted content %s", async (content, message) => {
    const files = new MemoryFiles();
    files.files.set(FILE, content);
    const store = storeWith(files);

    expect(await store.list()).toEqual([]);
    const warning = store.warning();
    expect(warning?.code).toBe("persistence_recovered");
    expect(warning?.message).toContain(message);
    expect(warning?.backupPath).toBe(`${FILE}.corrupt-42.bak`);
    expect(files.files.has(`${FILE}.corrupt-42.bak`)).toBe(true);
    expect(files.files.has(FILE)).toBe(false);
  });

  it("becomes read-only when corrupted content cannot be backed up", async () => {
    const files = new MemoryFiles();
    files.files.set(FILE, "broken");
    files.failRename = true;
    const store = storeWith(files);

    expect(await store.list()).toEqual([]);
    const warning = store.warning();
    expect(warning?.code).toBe("persistence_recovered");
    expect(warning?.backupPath).toBeUndefined();
    expect(warning?.message).toContain("暂时只读");
    await expect(store.create(recordFor())).rejects.toBeInstanceOf(
      DesktopError,
    );
    await expect(store.create(recordFor())).rejects.toMatchObject({
      code: "persistence_incompatible",
    });
  });

  it("never overwrites a file written by a newer version", async () => {
    const files = new MemoryFiles();
    files.files.set(
      FILE,
      JSON.stringify({ version: 9, environments: [recordFor()] }),
    );
    const store = storeWith(files);

    expect(await store.list()).toEqual([]);
    expect(store.warning()?.code).toBe("persistence_incompatible");
    expect(store.warning()?.message).toContain("版本为 9");
    await expect(store.create(recordFor())).rejects.toMatchObject({
      code: "persistence_incompatible",
    });
    expect(files.files.get(FILE)).toContain('"version":9');
  });

  it("keeps the previous file when a write fails", async () => {
    const files = new MemoryFiles();
    const store = storeWith(files);
    await store.create(recordFor());
    const original = files.files.get(FILE);
    files.failWrite = true;

    await expect(
      store.update({ ...recordFor(), name: "changed" }),
    ).rejects.toMatchObject({ code: "persistence_failed" });
    expect(files.files.get(FILE)).toBe(original);
    expect(await store.get("env-test")).toMatchObject({ name: "测试环境" });

    files.failWrite = false;
    await store.update({ ...recordFor(), name: "saved" });
    expect(await store.get("env-test")).toMatchObject({ name: "saved" });
  });

  it("reports directory creation failures and cleans the temporary file", async () => {
    const files = new MemoryFiles();
    files.failMkdir = true;
    const store = storeWith(files);
    await expect(store.create(recordFor())).rejects.toMatchObject({
      code: "persistence_failed",
    });
    expect(files.files.size).toBe(0);
  });

  it("reports unreadable files that are not missing", async () => {
    const files = new MemoryFiles();
    files.failRead = new Error("access denied");
    const store = storeWith(files);
    await expect(store.list()).rejects.toMatchObject({
      code: "persistence_failed",
    });
  });

  it("parses and truncates a stored launch result", async () => {
    const files = new MemoryFiles();
    const record = recordFor();
    files.files.set(
      FILE,
      validFile([
        {
          ...record,
          lastLaunch: {
            atUnixMs: 1_500,
            ok: false,
            code: "launch_failed",
            message: "x".repeat(600),
          },
        },
      ]),
    );
    const store = storeWith(files);
    const loaded = await store.get("env-test");
    expect(loaded?.lastLaunch).toEqual({
      atUnixMs: 1_500,
      ok: false,
      code: "launch_failed",
      message: "x".repeat(500),
    });
  });

  it.each([
    [{ atUnixMs: "now", ok: true, message: "x" }],
    [{ atUnixMs: 1, ok: "yes", message: "x" }],
    [{ atUnixMs: 1, ok: true, message: 3 }],
  ])("rejects an invalid stored launch result %j", async (lastLaunch) => {
    const files = new MemoryFiles();
    files.files.set(FILE, validFile([{ ...recordFor(), lastLaunch }]));
    const store = storeWith(files);
    expect(await store.list()).toEqual([]);
    expect(store.warning()?.code).toBe("persistence_recovered");
  });

  it("uses the absolute registry path", () => {
    const store = new JsonEnvironmentStore("relative/environments.json");
    expect(path.isAbsolute(store.filePath)).toBe(true);
  });
});
