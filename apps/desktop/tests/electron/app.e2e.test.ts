import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const appRoot = path.resolve(import.meta.dirname, "..", "..");
const mainEntry = path.join(appRoot, "dist", "main", "index.js");
const rendererEntry = path.join(appRoot, "dist", "renderer", "index.html");
const runtimeFileName =
  process.platform === "win32" ? "virealm-runtime.exe" : "virealm-runtime";
const runtimeExecutable = fileURLToPath(
  new URL(`../../../../target/debug/${runtimeFileName}`, import.meta.url),
);

const require = createRequire(import.meta.url);
const electronBinary: unknown = require("electron");

interface Launched {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly errors: string[];
}

let userData: string;
const launched: Launched[] = [];

function executablePath(): string {
  if (typeof electronBinary !== "string") {
    throw new Error("the electron package did not expose an executable path");
  }
  return electronBinary;
}

async function launchApp(): Promise<Launched> {
  const app = await electron.launch({
    executablePath: executablePath(),
    args: [appRoot],
    cwd: appRoot,
    env: {
      ...process.env,
      VIREALM_USER_DATA_DIR: userData,
      VIREALM_RUNTIME_PATH: runtimeExecutable,
    },
    timeout: 60_000,
  });
  const errors: string[] = [];
  app.process().stderr?.on("data", (chunk: Buffer | string) => {
    errors.push(String(chunk));
  });
  const page = await app.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  await page.waitForLoadState("domcontentloaded");
  const windowHandle = await app.browserWindow(page);
  await windowHandle.evaluate(
    (window: { setSize(width: number, height: number): void }) => {
      window.setSize(1280, 820);
    },
  );
  await page.waitForTimeout(1_500);
  const entry: Launched = { app, page, errors };
  launched.push(entry);
  return entry;
}

beforeAll(async () => {
  expect(
    existsSync(mainEntry),
    "build the desktop first: corepack pnpm build",
  ).toBe(true);
  expect(existsSync(rendererEntry)).toBe(true);
  expect(
    existsSync(runtimeExecutable),
    `build the runtime first (missing ${runtimeExecutable})`,
  ).toBe(true);
  userData = await mkdtemp(path.join(tmpdir(), "virealm-electron-e2e-"));
}, 60_000);

afterAll(async () => {
  for (const entry of launched.reverse()) {
    await entry.app.close().catch(() => undefined);
  }
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}, 120_000);

describe("Electron desktop", () => {
  it("renders a hardened renderer and creates an environment through the UI", async () => {
    const { page, errors } = await launchApp();
    expect(await page.title()).toBe("Virealm");
    await page
      .getByRole("heading", { name: "环境", exact: true })
      .waitFor({ state: "visible" });

    const security = await page.evaluate(() => {
      const scope = globalThis as unknown as {
        readonly require?: unknown;
        readonly process?: unknown;
        readonly virealm?: Readonly<Record<string, unknown>>;
      };
      return {
        hasRequire: typeof scope.require !== "undefined",
        hasProcess: typeof scope.process !== "undefined",
        apiKeys: Object.keys(scope.virealm ?? {}).sort(),
      };
    });
    expect(security.hasRequire).toBe(false);
    expect(security.hasProcess).toBe(false);
    expect(security.apiKeys).toEqual([
      "appInfo",
      "createEnvironment",
      "discoverBrowsers",
      "environmentDiagnostics",
      "getEnvironment",
      "getSettings",
      "launchEnvironment",
      "listEnvironments",
      "removeEnvironment",
      "restartRuntime",
      "runtimeStatus",
      "stopEnvironment",
      "updateEnvironment",
      "updateSettings",
      "verifyEnvironment",
    ]);

    const invalid = await page.evaluate(async () => {
      const scope = globalThis as unknown as {
        readonly virealm: {
          launchEnvironment(id: string): Promise<unknown>;
        };
      };
      return scope.virealm.launchEnvironment("NOT-A-VALID-ID");
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        message: "环境 id 无效。",
      },
    });

    await page.getByRole("button", { name: "新建环境" }).click();
    await page
      .getByRole("heading", { name: "新建环境" })
      .waitFor({ state: "visible" });
    await page.getByLabel("环境名称").fill("持久化测试环境");
    await page.getByRole("button", { name: "创建环境", exact: true }).click();
    await page
      .getByRole("button", { name: "持久化测试环境", exact: true })
      .waitFor({ state: "visible", timeout: 15_000 });
    expect(
      await page.evaluate(async () => {
        const scope = globalThis as unknown as {
          readonly virealm: {
            listEnvironments(): Promise<{
              readonly ok: boolean;
              readonly data?: readonly { readonly name: string }[];
            }>;
          };
        };
        return scope.virealm.listEnvironments();
      }),
    ).toMatchObject({
      ok: true,
      data: [expect.objectContaining({ name: "持久化测试环境" })],
    });

    const relevant = errors.filter(
      (entry) => !entry.includes("Electron Security Warning"),
    );
    expect(relevant).toEqual([]);
  }, 90_000);

  it("restores persisted metadata after a full restart", async () => {
    const first = launched[0];
    if (first === undefined) {
      throw new Error("the first application instance was not launched");
    }
    await first.app.close();

    const { page } = await launchApp();
    await page
      .getByRole("button", { name: "持久化测试环境", exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });
    const state = await page.evaluate(async () => {
      const scope = globalThis as unknown as {
        readonly virealm: {
          listEnvironments(): Promise<{
            readonly ok: boolean;
            readonly data?: readonly {
              readonly name: string;
              readonly state: string;
            }[];
          }>;
        };
      };
      return scope.virealm.listEnvironments();
    });
    expect(state).toMatchObject({
      ok: true,
      data: [
        {
          name: "持久化测试环境",
          state: "stopped",
        },
      ],
    });
  }, 90_000);
});
