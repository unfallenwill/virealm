import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertLoopbackEndpoint,
  readDevToolsEndpoint,
  waitForDevToolsEndpoint,
} from "../../src/chrome/devtools-endpoint.js";
import type { DevToolsEndpoint } from "../../src/chrome/devtools-endpoint.js";
import { BrowserAdapterError } from "../../src/domain/errors.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "virealm-endpoint-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writePortFile(root: string, content: string): void {
  writeFileSync(path.join(root, "DevToolsActivePort"), content);
}

describe("readDevToolsEndpoint", () => {
  it("reads the Chrome-allocated port and browser path", () => {
    const root = makeRoot();
    writePortFile(root, "54321\r\n/devtools/browser/abc-123\r\n");
    expect(readDevToolsEndpoint(root)).toEqual({
      port: 54_321,
      wsPath: "/devtools/browser/abc-123",
      endpoint: "ws://127.0.0.1:54321/devtools/browser/abc-123",
    });
  });

  it.each([
    "not-a-port\n/devtools/browser/x\n",
    "0\n/devtools/browser/x\n",
    "70000\n/devtools/browser/x\n",
    "1234\nnot-a-path\n",
    "1234",
    "1234\n",
  ])("rejects malformed content %j", (content) => {
    const root = makeRoot();
    writePortFile(root, content);
    expect(readDevToolsEndpoint(root)).toBeUndefined();
  });

  it("returns undefined when Chrome has not written the file", () => {
    expect(readDevToolsEndpoint(makeRoot())).toBeUndefined();
  });
});

describe("waitForDevToolsEndpoint", () => {
  it("returns as soon as the endpoint appears", async () => {
    const root = makeRoot();
    const writing = delay(20).then(() => {
      writePortFile(root, "32100\n/devtools/browser/late\n");
    });
    const endpoint = await waitForDevToolsEndpoint(root, {
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    });
    await writing;
    expect(endpoint.port).toBe(32_100);
  });

  it("fails fast when the process already exited", async () => {
    const root = makeRoot();
    await expect(
      waitForDevToolsEndpoint(root, {
        timeoutMs: 1_000,
        checkAlive: () =>
          Promise.resolve({
            alive: false,
            detail: "Chrome exited with code 1",
          }),
      }),
    ).rejects.toThrow(/exited with code 1/);
  });

  it("times out without a liveness callback", async () => {
    const root = makeRoot();
    await expect(
      waitForDevToolsEndpoint(root, { timeoutMs: 10, pollIntervalMs: 5 }),
    ).rejects.toMatchObject({ code: "cdp_timeout" });
  });

  it("times out with a typed error when no endpoint appears", async () => {
    const root = makeRoot();
    try {
      await waitForDevToolsEndpoint(root, {
        timeoutMs: 20,
        pollIntervalMs: 5,
        checkAlive: () => Promise.resolve({ alive: true, detail: "running" }),
      });
      throw new Error("expected a timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserAdapterError);
      if (error instanceof BrowserAdapterError) {
        expect(error.code).toBe("cdp_timeout");
      }
    }
  });
});

describe("assertLoopbackEndpoint", () => {
  const endpoint: DevToolsEndpoint = {
    port: 9_222,
    wsPath: "/devtools/browser/id",
    endpoint: "ws://127.0.0.1:9222/devtools/browser/id",
  };

  it("accepts a browser target even on a commonly used port", () => {
    expect(() => {
      assertLoopbackEndpoint(endpoint);
    }).not.toThrow();
  });

  it("rejects a non-browser debugging target", () => {
    expect(() => {
      assertLoopbackEndpoint({ ...endpoint, wsPath: "/json/version" });
    }).toThrow(/browser target/);
  });
});
