import { readFile } from "node:fs/promises";
import path from "node:path";

import { BrowserAdapter, type RuntimePort } from "@virealm/browser-adapter";
import { describe, expect, it } from "vitest";

import { redactMessage } from "../../src/main/logging.js";
import { IPC_CHANNELS } from "../../src/shared/contracts.js";
import {
  parseEnvironmentDraft,
  parseRemoveRequest,
  parseStopRequest,
} from "../../src/shared/validation.js";

const appRoot = path.resolve(import.meta.dirname, "..", "..");

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(appRoot, relativePath), "utf8");
}

describe("preload security boundary", () => {
  it("exposes exactly one fixed API and no generic privileged bridge", async () => {
    const preload = await source("src/preload/index.ts");
    expect(preload.match(/exposeInMainWorld\(/gu)).toHaveLength(1);
    expect(preload).toContain('exposeInMainWorld("virealm", api)');
    expect(preload).not.toMatch(/child_process|\bexec\b|\bspawn\b|\beval\b/u);
    expect(preload).not.toMatch(/from "node:(fs|child_process|net|http)"/u);
    expect(preload).not.toMatch(/ipcRenderer\.on|ipcRenderer\.send/u);

    const apiBlock = preload.slice(
      preload.indexOf("const api: DesktopApi = {"),
      preload.indexOf('contextBridge.exposeInMainWorld("virealm", api)'),
    );
    const methods = [
      ...apiBlock.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):/gmu),
    ].map((match) => match[1]);
    expect(methods).toEqual([
      "listEnvironments",
      "getEnvironment",
      "createEnvironment",
      "updateEnvironment",
      "removeEnvironment",
      "launchEnvironment",
      "stopEnvironment",
      "verifyEnvironment",
      "environmentDiagnostics",
      "discoverBrowsers",
      "runtimeStatus",
      "restartRuntime",
      "appInfo",
      "getSettings",
      "updateSettings",
    ]);
  });

  it("keeps IPC channels namespaced, unique and allowlisted", () => {
    const channels = Object.values(IPC_CHANNELS);
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels.every((channel) => channel.startsWith("virealm:"))).toBe(
      true,
    );
    for (const channel of channels) {
      expect(channel).toMatch(/^virealm:[a-z]+:[a-zA-Z]+$/u);
    }
  });
});

describe("IPC payload hardening", () => {
  it("rejects privilege-shaped fields instead of ignoring them", () => {
    expect(
      parseEnvironmentDraft({
        name: "x",
        runtimePolicy: { isolation: "managed" },
        command: "calc.exe",
      }).ok,
    ).toBe(false);
    expect(parseRemoveRequest({ deleteData: true, path: "C:\\" }).ok).toBe(
      false,
    );
    expect(parseStopRequest({ force: true, signal: "SIGKILL" }).ok).toBe(false);
  });

  it("delegates unsafe Chrome switches to the adapter's reserved list", () => {
    const adapter = new BrowserAdapter({
      dataRoot: path.join(appRoot, ".security-test-data"),
      runtime: {} as unknown as RuntimePort,
      localAppData: "C:\\Users\\Public",
    });
    const result = adapter.validateEnvironment({
      id: "env-security",
      name: "Security",
      browser: {},
      runtimePolicy: { isolation: "managed" },
      persistence: { mode: "persistent" },
      launch: {
        additionalArguments: [
          "--user-data-dir=C:\\outside",
          "--remote-debugging-port=9222",
          "--no-sandbox",
          "--disable-web-security",
        ],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "launch.additionalArguments.0",
        "launch.additionalArguments.1",
        "launch.additionalArguments.2",
        "launch.additionalArguments.3",
      ]),
    );
  });
});

describe("diagnostic redaction", () => {
  it("never leaves debugger paths or credentials in log text", () => {
    const text = redactMessage(
      "connect ws://127.0.0.1:9333/devtools/browser/123456 cookie=session access_token=abcdef password=hunter2",
    );
    expect(text).not.toContain("123456");
    expect(text).not.toContain("session");
    expect(text).not.toContain("abcdef");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("/devtools/browser/[redacted]");
  });
});
