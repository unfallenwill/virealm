import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  CapabilityReport,
  LaunchParams,
  ProcessStatus,
} from "@virealm/contracts";
import { RuntimeHost } from "@virealm/runtime-client";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserAdapter } from "../../src/browser-adapter.js";
import { discoverBrowsers } from "../../src/chrome/discovery.js";
import type { BrowserEnvironmentConfig } from "../../src/domain/environment.js";
import { BrowserAdapterError } from "../../src/domain/errors.js";
import type {
  ConfigFieldResult,
  EnvironmentConfigReport,
} from "../../src/domain/status.js";
import type { RuntimePort } from "../../src/application/ports.js";
import { ProcessRuntimeClient } from "../../src/runtime/process-runtime-client.js";

const execFileAsync = promisify(execFile);

const runtimeExecutable =
  process.env.VIREALM_RUNTIME_EXECUTABLE ??
  fileURLToPath(
    new URL("../../../../target/debug/virealm-runtime.exe", import.meta.url),
  );

const discovered = discoverBrowsers();
const chrome = discovered[0];
const available =
  process.platform === "win32" &&
  existsSync(runtimeExecutable) &&
  chrome !== undefined;

if (!available) {
  console.warn(
    "[browser-adapter integration] prerequisites missing; real Chrome tests are skipped:",
    {
      platform: process.platform,
      runtimeExecutable,
      runtimeExists: existsSync(runtimeExecutable),
      chrome: chrome?.executablePath,
    },
  );
}

describe("integration prerequisites", () => {
  it("has a built runtime and a local Chrome", () => {
    expect(
      process.platform,
      "these tests exercise Windows Job Objects and named pipes",
    ).toBe("win32");
    expect(
      existsSync(runtimeExecutable),
      `build the runtime first: cargo build -p virealm-process-runtime --bin virealm-runtime (missing ${runtimeExecutable})`,
    ).toBe(true);
    expect(
      discovered.length,
      "Chrome was not found in a standard Windows install location",
    ).toBeGreaterThan(0);
  });
});

/** Counts runtime launches without changing any other behaviour. */
class CountingRuntime implements RuntimePort {
  launchCount = 0;
  private readonly inner: ProcessRuntimeClient;

  constructor(inner: ProcessRuntimeClient) {
    this.inner = inner;
  }

  getCapabilities(signal?: AbortSignal): Promise<CapabilityReport> {
    return this.inner.getCapabilities(signal);
  }

  launch(params: LaunchParams, signal?: AbortSignal): Promise<ProcessStatus> {
    this.launchCount += 1;
    return this.inner.launch(params, signal);
  }

  getStatus(
    processInstanceId: string,
    signal?: AbortSignal,
  ): Promise<ProcessStatus> {
    return this.inner.getStatus(processInstanceId, signal);
  }

  terminate(
    processInstanceId: string,
    signal?: AbortSignal,
  ): Promise<ProcessStatus> {
    return this.inner.terminate(processInstanceId, signal);
  }
}

interface Harness {
  readonly adapter: BrowserAdapter;
  readonly client: ProcessRuntimeClient;
  readonly runtime: CountingRuntime;
  readonly host: RuntimeHost;
  readonly dataRoot: string;
  readonly root: string;
  readonly baseUrl: string;
  readonly server: Server;
  readonly active: Set<string>;
  readonly acceptLanguageByPath: Map<string, string | undefined>;
}

let harness: Harness | undefined;

function platform(): Harness {
  if (harness === undefined) {
    throw new Error("integration harness is not initialised");
  }
  return harness;
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be present`);
  }
  return value;
}

function chromeOf(): string {
  if (chrome === undefined) {
    throw new Error("Chrome is not available");
  }
  return chrome.executablePath;
}

function chromeVersion(): string | undefined {
  return chrome === undefined || chrome.version === "unknown"
    ? undefined
    : chrome.version;
}

function configFor(
  id: string,
  options: {
    readonly timezone: string;
    readonly locale: string;
    readonly viewport?: BrowserEnvironmentConfig["viewport"];
  },
): BrowserEnvironmentConfig {
  const version = chromeVersion();
  return {
    id,
    name: `Integration ${id}`,
    browser: {
      executablePath: chromeOf(),
      ...(version === undefined ? {} : { version }),
    },
    locale: options.locale,
    timezone: options.timezone,
    ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
    runtimePolicy: { isolation: "managed" },
    persistence: { mode: "persistent" },
    launch: {
      initialUrls: [`${platform().baseUrl}/page-${id}`],
      additionalArguments: ["--headless=new"],
    },
  };
}

async function launch(
  id: string,
  options: {
    readonly timezone: string;
    readonly locale: string;
    readonly viewport?: BrowserEnvironmentConfig["viewport"];
  },
): Promise<void> {
  const h = platform();
  const config = configFor(id, options);
  const validation = h.adapter.validateEnvironment(config);
  if (!validation.valid) {
    throw new Error(
      `integration config for ${id} is invalid: ${JSON.stringify(validation.issues)}`,
    );
  }
  const result = await h.adapter.launchEnvironment(config);
  h.active.add(id);
  expect(result.status.state).toBe("running");
  expect(result.status.cdp.connected).toBe(true);
}

function field(
  report: EnvironmentConfigReport,
  name: string,
): ConfigFieldResult {
  const found = report.fields.find((entry) => entry.field === name);
  if (found === undefined) {
    throw new Error(`missing config field ${name}`);
  }
  return found;
}

async function withPage<T>(
  endpoint: string,
  action: (page: Page) => Promise<T>,
): Promise<T> {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context = browser.contexts()[0];
    if (context === undefined) {
      throw new Error("the CDP endpoint has no browser context");
    }
    const page = context.pages()[0] ?? (await context.newPage());
    return await action(page);
  } finally {
    // For `connectOverCDP` this disconnects from Chrome; it does not close it.
    await browser.close().catch(() => undefined);
  }
}

async function chromeCommandLines(): Promise<string[]> {
  const script =
    "$items = @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object -ExpandProperty CommandLine); ConvertTo-Json -Compress -InputObject $items";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  const parsed: unknown = JSON.parse(stdout.trim() || "[]");
  if (typeof parsed === "string") {
    return [parsed];
  }
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function linesForProfile(userDataDir: string): Promise<string[]> {
  const all = await chromeCommandLines();
  return all.filter((line) => line.includes(userDataDir));
}

async function endpointAnswers(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  url.protocol = "http:";
  url.pathname = "/json/version";
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

describe.skipIf(!available)(
  "BrowserAdapter with real Chrome and runtime",
  () => {
    beforeAll(async () => {
      const root = mkdtempSync(path.join(tmpdir(), "virealm-it-"));
      const pipePath = `\\\\.\\pipe\\virealm-it-${randomUUID()}`;
      const host = await RuntimeHost.start({
        executablePath: runtimeExecutable,
        pipePath,
        startupTimeoutMs: 20_000,
      });
      const client = new ProcessRuntimeClient({
        pipePath,
        connectTimeoutMs: 5_000,
        requestTimeoutMs: 60_000,
      });
      const counting = new CountingRuntime(client);

      const acceptLanguageByPath = new Map<string, string | undefined>();
      const server = createServer((request, response) => {
        const route = request.url ?? "/";
        acceptLanguageByPath.set(
          route,
          typeof request.headers["accept-language"] === "string"
            ? request.headers["accept-language"]
            : undefined,
        );
        if (route === "/headers") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              acceptLanguage: request.headers["accept-language"] ?? null,
            }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><html><head><title>${route.slice(1)}</title></head><body>` +
            `<h1>${route}</h1><a id="popup-link" href="${route}-popup" target="_blank">popup</a>` +
            `</body></html>`,
        );
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = (server.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${String(port)}`;

      const dataRoot = path.join(root, "data");
      const localAppData = process.env.LOCALAPPDATA;
      const adapter = new BrowserAdapter({
        dataRoot,
        runtime: counting,
        ...(localAppData === undefined ? {} : { localAppData }),
        networkProbeUrl: `${baseUrl}/headers`,
        timeouts: {
          launchMs: 60_000,
          cdpConnectMs: 30_000,
          stopMs: 20_000,
          configVerifyMs: 10_000,
          endpointProbeMs: 3_000,
        },
      });

      harness = {
        adapter,
        client,
        runtime: counting,
        host,
        dataRoot,
        root,
        baseUrl,
        server,
        active: new Set(),
        acceptLanguageByPath,
      };
    });

    afterAll(async () => {
      const h = harness;
      if (h === undefined) {
        return;
      }
      for (const id of h.active) {
        await h.adapter
          .stopEnvironment(id, { mode: "force", timeoutMs: 10_000 })
          .catch(() => undefined);
      }
      await h.adapter.close().catch(() => undefined);
      h.client.close();
      await h.host.stop();
      h.server.closeAllConnections();
      await new Promise<void>((resolve) => {
        h.server.close(() => {
          resolve();
        });
      });
      rmSync(h.root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    });

    it("discovers the installed Chrome with a real version", () => {
      const h = platform();
      expect(chrome?.executablePath).toMatch(/chrome\.exe$/i);
      expect(chrome?.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(
        h.adapter
          .discoverBrowsers(chromeOf())
          .some((entry) => entry.source === "explicit"),
      ).toBe(true);
    });

    it("launches Chrome through the runtime and verifies timezone, locale, viewport and headers", async () => {
      const h = platform();
      await launch("env_a", {
        timezone: "Asia/Singapore",
        locale: "en-US",
        viewport: { width: 1_366, height: 768 },
      });

      const status = await h.adapter.getEnvironmentStatus("env_a");
      const endpoint = required(status.cdp.endpoint, "CDP endpoint");
      const profile = required(status.userDataDir, "user data directory");
      expect(status.processInstanceId).toBeDefined();
      expect(status.browserVersion).toBe(chromeVersion());
      expect(endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
      expect(profile.toLowerCase().startsWith(h.dataRoot.toLowerCase())).toBe(
        true,
      );
      expect(existsSync(profile)).toBe(true);

      const verified = await h.adapter.verifyEnvironmentConfig("env_a");
      expect(field(verified, "timezone")).toMatchObject({
        status: "verified",
        requested: "Asia/Singapore",
        observed: "Asia/Singapore",
      });
      expect(field(verified, "locale")).toMatchObject({
        status: "verified",
        requested: "en-US",
        observed: { language: "en-US" },
      });
      expect(field(verified, "viewport")).toMatchObject({
        status: "verified",
        requested: { width: 1_366, height: 768 },
        observed: { width: 1_366, height: 768 },
      });
      expect(field(verified, "acceptLanguage")).toMatchObject({
        status: "verified",
      });

      const observed = await withPage(endpoint, async (page) => {
        await page.goto(`${h.baseUrl}/page-env_a`);
        return page.evaluate(() => ({
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          language: navigator.language,
          languages: navigator.languages.join(","),
          width: window.innerWidth,
          height: window.innerHeight,
        }));
      });
      expect(observed.timezone).toBe("Asia/Singapore");
      expect(observed.language).toBe("en-US");
      expect(observed.languages).toContain("en-US");
      expect(observed.width).toBe(1_366);
      expect(observed.height).toBe(768);

      expect(h.acceptLanguageByPath.get("/headers")?.toLowerCase()).toContain(
        "en-us",
      );

      const lines = await linesForProfile(profile);
      expect(lines.length).toBeGreaterThan(0);
      expect(
        lines.some(
          (line) =>
            line.includes("--remote-debugging-port=0") &&
            line.includes("--remote-debugging-address=127.0.0.1") &&
            line.includes(`--user-data-dir=${profile}`),
        ),
      ).toBe(true);
      const browserLine = lines.find((line) =>
        line.includes("--remote-debugging-port=0"),
      );
      expect(browserLine).toBeDefined();
      expect(browserLine).not.toContain("--no-sandbox");
      expect(browserLine).not.toContain("--disable-web-security");
      expect(
        lines.some((line) => line.includes("--remote-debugging-port=9222")),
      ).toBe(false);
    });

    it("opens, navigates and closes targets over the real CDP connection", async () => {
      const h = platform();
      await launch("env_targets", {
        timezone: "Asia/Singapore",
        locale: "en-US",
      });

      const opened = await h.adapter.openPage(
        "env_targets",
        `${h.baseUrl}/page-open`,
      );
      expect(opened.url).toBe(`${h.baseUrl}/page-open`);
      const navigated = await h.adapter.navigatePage(
        "env_targets",
        opened.pageId,
        `${h.baseUrl}/page-navigated`,
      );
      expect(navigated.url).toBe(`${h.baseUrl}/page-navigated`);
      const pages = await h.adapter.listPages("env_targets");
      expect(pages.some((page) => page.url.endsWith("/page-navigated"))).toBe(
        true,
      );

      const running = await h.adapter.getEnvironmentStatus("env_targets");
      const endpoint = required(running.cdp.endpoint, "CDP endpoint");
      await withPage(endpoint, async (page) => {
        await page.goto(`${h.baseUrl}/page-popup-source`);
        await page.click("#popup-link");
      });
      const popupOpened = await waitFor(async () =>
        (await h.adapter.listPages("env_targets")).some((page) =>
          page.url.includes("page-popup-source-popup"),
        ),
      );
      expect(popupOpened).toBe(true);

      // Verification covers every live page, so this also proves the popup
      // received the same timezone/locale overrides.
      const verifiedTargets =
        await h.adapter.verifyEnvironmentConfig("env_targets");
      expect(verifiedTargets.pages.length).toBeGreaterThanOrEqual(2);
      expect(field(verifiedTargets, "timezone")).toMatchObject({
        status: "verified",
        observed: "Asia/Singapore",
      });
      expect(field(verifiedTargets, "locale")).toMatchObject({
        status: "verified",
      });

      await h.adapter.closePage("env_targets", opened.pageId);
      expect(
        (await h.adapter.listPages("env_targets")).some(
          (page) => page.pageId === opened.pageId,
        ),
      ).toBe(false);
    });

    it("disconnects and reconnects CDP without stopping Chrome", async () => {
      const h = platform();
      await launch("env_reconnect", {
        timezone: "America/Los_Angeles",
        locale: "en-GB",
      });
      const before = await h.adapter.getEnvironmentStatus("env_reconnect");
      const endpoint = required(before.cdp.endpoint, "CDP endpoint");

      const disconnected =
        await h.adapter.disconnectEnvironment("env_reconnect");
      expect(disconnected.state).toBe("running");
      expect(disconnected.cdp.connected).toBe(false);
      expect(await endpointAnswers(endpoint)).toBe(true);

      const reconnected = await h.adapter.connectEnvironment(
        configFor("env_reconnect", {
          timezone: "America/Los_Angeles",
          locale: "en-GB",
        }),
      );
      expect(reconnected.status.cdp.connected).toBe(true);
      expect(reconnected.status.processInstanceId).toBe(
        before.processInstanceId,
      );

      const verified = await h.adapter.verifyEnvironmentConfig("env_reconnect");
      expect(field(verified, "timezone")).toMatchObject({
        status: "verified",
        observed: "America/Los_Angeles",
      });
      expect(field(verified, "locale")).toMatchObject({
        status: "verified",
        observed: { language: "en-GB" },
      });
    });

    it("persists cookies and localStorage across a stop and relaunch", async () => {
      const h = platform();
      await launch("env_persist", {
        timezone: "Asia/Singapore",
        locale: "en-US",
      });
      const first = await h.adapter.getEnvironmentStatus("env_persist");
      const endpoint = required(first.cdp.endpoint, "CDP endpoint");
      const profile = required(first.userDataDir, "user data directory");

      await withPage(endpoint, async (page) => {
        await page.goto(`${h.baseUrl}/page-persist`);
        await page.evaluate(() => {
          localStorage.setItem("virealm-local", "kept");
          document.cookie = "virealm_cookie=kept; path=/; max-age=3600";
        });
      });

      const stopped = await h.adapter.stopEnvironment("env_persist", {
        mode: "graceful",
        timeoutMs: 20_000,
      });
      h.active.delete("env_persist");
      expect(stopped.state).toBe("stopped");
      expect(existsSync(profile)).toBe(true);
      expect(
        await endpointAnswers(required(first.cdp.endpoint, "CDP endpoint")),
      ).toBe(false);

      await launch("env_persist", {
        timezone: "Asia/Singapore",
        locale: "en-US",
      });
      const second = await h.adapter.getEnvironmentStatus("env_persist");
      expect(second.processInstanceId).not.toBe(first.processInstanceId);
      expect(second.userDataDir).toBe(profile);

      const storage = await withPage(
        required(second.cdp.endpoint, "CDP endpoint"),
        async (page) => {
          await page.goto(`${h.baseUrl}/page-persist`);
          return page.evaluate(() => ({
            local: localStorage.getItem("virealm-local"),
            cookie: document.cookie,
          }));
        },
      );
      expect(storage.local).toBe("kept");
      expect(storage.cookie).toContain("virealm_cookie=kept");
    });

    it("isolates two environments and keeps B running when A stops", async () => {
      const h = platform();
      await launch("env_iso_a", {
        timezone: "Asia/Singapore",
        locale: "en-US",
        viewport: { width: 1_200, height: 800 },
      });
      await launch("env_iso_b", {
        timezone: "America/Los_Angeles",
        locale: "en-GB",
        viewport: { width: 1_000, height: 700 },
      });

      const reportA = await h.adapter.verifyEnvironmentConfig("env_iso_a");
      const reportB = await h.adapter.verifyEnvironmentConfig("env_iso_b");
      expect(field(reportA, "timezone")).toMatchObject({
        status: "verified",
        observed: "Asia/Singapore",
      });
      expect(field(reportB, "timezone")).toMatchObject({
        status: "verified",
        observed: "America/Los_Angeles",
      });
      expect(field(reportA, "locale")).toMatchObject({
        status: "verified",
        observed: { language: "en-US" },
      });
      expect(field(reportB, "locale")).toMatchObject({
        status: "verified",
        observed: { language: "en-GB" },
      });

      const statusA = await h.adapter.getEnvironmentStatus("env_iso_a");
      const statusB = await h.adapter.getEnvironmentStatus("env_iso_b");
      expect(statusA.userDataDir).not.toBe(statusB.userDataDir);
      const endpointA = required(statusA.cdp.endpoint, "A endpoint");
      const endpointB = required(statusB.cdp.endpoint, "B endpoint");
      expect(endpointA).not.toBe(endpointB);
      expect(endpointA).toMatch(/^ws:\/\/127\.0\.0\.1:/);
      expect(endpointB).toMatch(/^ws:\/\/127\.0\.0\.1:/);

      const seenByA = await withPage(endpointA, async (page) => {
        await page.goto(`${h.baseUrl}/page-iso-a`);
        await page.evaluate(() => {
          localStorage.setItem("virealm-owner", "A");
        });
        const urls = page
          .context()
          .pages()
          .map((entry) => entry.url());
        return {
          urls,
          storage: await page.evaluate(() =>
            localStorage.getItem("virealm-owner"),
          ),
        };
      });
      const seenByB = await withPage(endpointB, async (page) => {
        await page.goto(`${h.baseUrl}/page-iso-b`);
        await page.evaluate(() => {
          localStorage.setItem("virealm-owner", "B");
        });
        const urls = page
          .context()
          .pages()
          .map((entry) => entry.url());
        return {
          urls,
          storage: await page.evaluate(() =>
            localStorage.getItem("virealm-owner"),
          ),
        };
      });
      expect(seenByA.storage).toBe("A");
      expect(seenByB.storage).toBe("B");
      expect(seenByB.urls.some((url) => url.includes("page-iso-a"))).toBe(
        false,
      );
      expect(seenByA.urls.some((url) => url.includes("page-iso-b"))).toBe(
        false,
      );

      const stoppedA = await h.adapter.stopEnvironment("env_iso_a", {
        mode: "graceful",
        timeoutMs: 20_000,
      });
      h.active.delete("env_iso_a");
      expect(stoppedA.state).toBe("stopped");
      expect(await endpointAnswers(endpointA)).toBe(false);

      const statusBAfter = await h.adapter.getEnvironmentStatus("env_iso_b");
      expect(statusBAfter.state).toBe("running");
      expect(statusBAfter.cdp.connected).toBe(true);
      expect(await endpointAnswers(endpointB)).toBe(true);
      const verifiedB = await h.adapter.verifyEnvironmentConfig("env_iso_b");
      expect(field(verifiedB, "timezone")).toMatchObject({
        status: "verified",
        observed: "America/Los_Angeles",
      });
      expect(field(verifiedB, "locale")).toMatchObject({
        status: "verified",
        observed: { language: "en-GB" },
      });
    });

    it("reports an externally terminated browser without deleting its profile", async () => {
      const h = platform();
      await launch("env_abnormal", {
        timezone: "Asia/Singapore",
        locale: "en-US",
      });
      const before = await h.adapter.getEnvironmentStatus("env_abnormal");
      const profile = required(before.userDataDir, "user data directory");

      await h.client.terminate(
        required(before.processInstanceId, "instance id"),
      );
      const status = await h.adapter.getEnvironmentStatus("env_abnormal");
      h.active.delete("env_abnormal");
      expect(["stopped", "failed"]).toContain(status.state);
      expect(status.lastError?.code).toBe("browser_exited");
      expect(status.cdp.connected).toBe(false);
      expect(existsSync(profile)).toBe(true);
    });

    it("force-stops the whole Chrome process tree and keeps the profile", async () => {
      const h = platform();
      await launch("env_force", {
        timezone: "Asia/Singapore",
        locale: "en-US",
      });
      const before = await h.adapter.getEnvironmentStatus("env_force");
      const profile = required(before.userDataDir, "user data directory");
      const endpoint = required(before.cdp.endpoint, "CDP endpoint");
      expect((await linesForProfile(profile)).length).toBeGreaterThan(0);

      const stopped = await h.adapter.stopEnvironment("env_force", {
        mode: "force",
        timeoutMs: 20_000,
      });
      h.active.delete("env_force");
      expect(stopped.state).toBe("stopped");
      expect(await endpointAnswers(endpoint)).toBe(false);
      expect(
        await waitFor(
          async () => (await linesForProfile(profile)).length === 0,
        ),
      ).toBe(true);
      expect(existsSync(profile)).toBe(true);
    });

    it("never downgrades an isolation policy the runtime does not support", async () => {
      const h = platform();
      const capabilities = await h.client.getCapabilities();
      const unsupported =
        capabilities.appContainer.state !== "supported"
          ? "app_container"
          : capabilities.restrictedToken.state !== "supported"
            ? "restricted"
            : undefined;
      if (unsupported === undefined) {
        // This machine can provide every isolation level; the unit suite covers
        // the refusal path with a runtime that cannot.
        return;
      }
      const before = h.runtime.launchCount;
      const config = {
        ...configFor("env_isolation", {
          timezone: "Asia/Singapore",
          locale: "en-US",
        }),
        runtimePolicy: { isolation: unsupported },
      };
      await expect(h.adapter.launchEnvironment(config)).rejects.toMatchObject({
        code: "unsupported_isolation",
      });
      expect(h.runtime.launchCount).toBe(before);
    });

    it("explains that Chromium cannot start inside a restricted token", async () => {
      const h = platform();
      const capabilities = await h.client.getCapabilities();
      if (capabilities.restrictedToken.state !== "supported") {
        return;
      }
      const config = {
        ...configFor("env_restricted_token", {
          timezone: "Asia/Singapore",
          locale: "en-US",
        }),
        runtimePolicy: { isolation: "restricted" },
      };
      const failure = await h.adapter.launchEnvironment(config).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeDefined();
      expect(failure).toMatchObject({
        code: "unsupported_isolation",
        details: { isolation: "restricted" },
      });
      const details = (failure as BrowserAdapterError).details as {
        isolation: string;
        exitCode: number;
        reason: string;
      };
      // The abort code is not stable across Chromium builds: this machine
      // reports STATUS_BREAKPOINT, a runner with another build reports a
      // different code. The classification must not depend on one value, but
      // the code that was observed is still reported.
      expect(details.exitCode).toBeTypeOf("number");
      // The observed abort code is build specific, so it is printed for the
      // CI log rather than assumed.
      console.log(
        `restricted-token launch aborted with code ${String(details.exitCode)} (0x${details.exitCode.toString(16)})`,
      );
      expect([
        "status_breakpoint",
        "early_exit_under_restricted_isolation",
      ]).toContain(details.reason);
      expect((failure as Error).message).toContain(
        "cannot start its own sandbox inside a restricted-token token",
      );
      if (details.reason === "status_breakpoint") {
        expect(details.exitCode).toBe(0x80000003);
        expect((failure as Error).message).toContain("STATUS_BREAKPOINT");
      }
    });
  },
);
