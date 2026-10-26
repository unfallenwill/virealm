import path from "node:path";

import { describe, expect, it } from "vitest";

import { JsonSettingsStore } from "../../src/main/persistence/settings-store.js";
import {
  TEST_CHROME_PATH,
  TEST_DATA_ROOT,
  MemoryFiles,
} from "./helpers/fakes.js";

const FILE = path.join(TEST_DATA_ROOT, "settings.json");

describe("JsonSettingsStore", () => {
  it("starts with dark theme and no browser override", async () => {
    const store = new JsonSettingsStore(FILE, new MemoryFiles(), () => 9);
    expect(await store.get()).toEqual({
      theme: "dark",
      defaultBrowserPath: undefined,
    });
    expect(store.warning()).toBeUndefined();
  });

  it("persists theme and browser changes", async () => {
    const files = new MemoryFiles();
    const store = new JsonSettingsStore(FILE, files, () => 9);

    expect(await store.update({ theme: "light" })).toEqual({
      theme: "light",
      defaultBrowserPath: undefined,
    });
    expect(
      await store.update({ defaultBrowserPath: TEST_CHROME_PATH }),
    ).toEqual({
      theme: "light",
      defaultBrowserPath: TEST_CHROME_PATH,
    });
    expect(await store.update({})).toEqual({
      theme: "light",
      defaultBrowserPath: TEST_CHROME_PATH,
    });
    expect(JSON.parse(files.files.get(FILE) ?? "{}")).toMatchObject({
      version: 1,
      theme: "light",
      defaultBrowserPath: TEST_CHROME_PATH,
    });
  });

  it("clears an explicit default browser path", async () => {
    const files = new MemoryFiles();
    const store = new JsonSettingsStore(FILE, files);
    await store.update({ defaultBrowserPath: TEST_CHROME_PATH });

    expect(await store.update({ defaultBrowserPath: undefined })).toEqual({
      theme: "dark",
      defaultBrowserPath: undefined,
    });
    const persisted = JSON.parse(files.files.get(FILE) ?? "{}") as Record<
      string,
      unknown
    >;
    expect("defaultBrowserPath" in persisted).toBe(false);
  });

  it("loads a valid persisted file", async () => {
    const files = new MemoryFiles();
    files.files.set(
      FILE,
      JSON.stringify({
        version: 1,
        theme: "system",
        defaultBrowserPath: TEST_CHROME_PATH,
      }),
    );
    const store = new JsonSettingsStore(FILE, files);
    expect(await store.get()).toEqual({
      theme: "system",
      defaultBrowserPath: TEST_CHROME_PATH,
    });
  });

  it.each([
    ["not json"],
    ["[]"],
    ['{"version":2,"theme":"dark"}'],
    ['{"version":1,"theme":"blue"}'],
    ['{"version":1,"theme":"dark","defaultBrowserPath":""}'],
    ['{"version":1,"theme":"dark","defaultBrowserPath":3}'],
    [`{"version":1,"theme":"dark","defaultBrowserPath":"${"x".repeat(4097)}"}`],
  ])("backs up invalid settings %s", async (content) => {
    const files = new MemoryFiles();
    files.files.set(FILE, content);
    const store = new JsonSettingsStore(FILE, files, () => 77);

    expect(await store.get()).toEqual({
      theme: "dark",
      defaultBrowserPath: undefined,
    });
    expect(store.warning()).toContain(`${FILE}.corrupt-77.bak`);
    expect(files.files.has(`${FILE}.corrupt-77.bak`)).toBe(true);
    expect(files.files.has(FILE)).toBe(false);
  });

  it("uses defaults when invalid settings cannot be backed up", async () => {
    const files = new MemoryFiles();
    files.files.set(FILE, "broken");
    files.failRename = true;
    const store = new JsonSettingsStore(FILE, files);
    expect((await store.get()).theme).toBe("dark");
    expect(store.warning()).toContain("无法备份");
  });

  it("preserves the previous file when a write fails", async () => {
    const files = new MemoryFiles();
    const store = new JsonSettingsStore(FILE, files);
    await store.update({ theme: "light" });
    files.failWrite = true;

    await expect(store.update({ theme: "system" })).rejects.toMatchObject({
      code: "persistence_failed",
    });
    expect(await store.get()).toEqual({
      theme: "light",
      defaultBrowserPath: undefined,
    });
    expect(files.files.has(`${FILE}.${String(process.pid)}.2.tmp`)).toBe(false);
  });

  it("reports unreadable files that are not missing", async () => {
    const files = new MemoryFiles();
    files.failRead = new Error("permission denied");
    const store = new JsonSettingsStore(FILE, files);
    await expect(store.get()).rejects.toMatchObject({
      code: "persistence_failed",
    });
  });
});
