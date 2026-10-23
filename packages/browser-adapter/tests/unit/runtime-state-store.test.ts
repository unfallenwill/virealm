import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonRuntimeStateStore } from "../../src/persistence/runtime-state-store.js";
import type { PersistedRuntimeState } from "../../src/domain/status.js";

const roots: string[] = [];

function makeStore(): JsonRuntimeStateStore {
  const root = mkdtempSync(path.join(tmpdir(), "virealm-state-"));
  roots.push(root);
  return new JsonRuntimeStateStore(root);
}

function state(
  environmentId: string,
  overrides: Partial<PersistedRuntimeState> = {},
): PersistedRuntimeState {
  return {
    environmentId,
    processInstanceId: "100:133000000000000000",
    pid: 100,
    startedAtUnixMs: 1_700_000_000_000,
    userDataDir: `C:\\VirealmData\\environments\\${environmentId}\\chrome-data`,
    endpoint: "ws://127.0.0.1:1234/devtools/browser/id",
    browserVersion: "156.0.8078.48",
    state: "running",
    updatedAtUnixMs: 1_700_000_000_000,
    lastError: undefined,
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("JsonRuntimeStateStore", () => {
  it("treats a missing file as empty state", async () => {
    const store = makeStore();
    expect(await store.read("env_a")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("persists and reads runtime handles", async () => {
    const store = makeStore();
    await store.write(state("env_a"));
    await store.write(
      state("env_b", {
        state: "stopped",
        endpoint: undefined,
        lastError: { code: "browser_exited", message: "exited" },
      }),
    );

    const first = await store.read("env_a");
    expect(first?.state).toBe("running");
    expect(first?.endpoint).toContain("/devtools/browser/");
    const all = await store.list();
    expect(all.map((entry) => entry.environmentId).sort()).toEqual([
      "env_a",
      "env_b",
    ]);
    expect(
      all.find((entry) => entry.environmentId === "env_b")?.lastError,
    ).toEqual({ code: "browser_exited", message: "exited" });

    const content = JSON.parse(readFileSync(store.filePath, "utf8")) as {
      version: number;
      environments: Record<string, unknown>;
    };
    expect(content.version).toBe(1);
    expect(Object.keys(content.environments).sort()).toEqual([
      "env_a",
      "env_b",
    ]);
  });

  it("writes atomically without leaving a temporary file", async () => {
    const store = makeStore();
    await store.write(state("env_a"));
    expect(existsSync(`${store.filePath}.tmp`)).toBe(false);
  });

  it("serialises concurrent writes", async () => {
    const store = makeStore();
    await Promise.all([
      store.write(state("env_a")),
      store.write(state("env_b")),
      store.write(state("env_c")),
    ]);
    expect(
      (await store.list()).map((entry) => entry.environmentId).sort(),
    ).toEqual(["env_a", "env_b", "env_c"]);
  });

  it("reports malformed JSON as persistence_corrupted", async () => {
    const store = makeStore();
    writeFileSync(store.filePath, "{");
    await expect(store.read("env_a")).rejects.toMatchObject({
      code: "persistence_corrupted",
    });
  });

  it("rejects an unsupported file version", async () => {
    const store = makeStore();
    writeFileSync(
      store.filePath,
      JSON.stringify({ version: 2, environments: {} }),
    );
    await expect(store.list()).rejects.toMatchObject({
      code: "persistence_corrupted",
    });
  });

  it("rejects an invalid entry shape", async () => {
    const store = makeStore();
    writeFileSync(
      store.filePath,
      JSON.stringify({
        version: 1,
        environments: {
          env_a: { environmentId: "env_a", pid: "not-a-number" },
        },
      }),
    );
    await expect(store.read("env_a")).rejects.toMatchObject({
      code: "persistence_corrupted",
    });
  });

  it("ignores unknown optional fields while keeping the known shape", async () => {
    const store = makeStore();
    writeFileSync(
      store.filePath,
      JSON.stringify({
        version: 1,
        environments: {
          env_a: {
            ...state("env_a"),
            endpoint: 42,
            browserVersion: null,
            lastError: { code: 1 },
            extra: "ignored",
          },
        },
      }),
    );
    const entry = await store.read("env_a");
    expect(entry?.endpoint).toBeUndefined();
    expect(entry?.browserVersion).toBeUndefined();
    expect(entry?.lastError).toBeUndefined();
  });
});
