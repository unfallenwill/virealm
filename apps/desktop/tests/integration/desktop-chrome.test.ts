import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserAdapter } from "@virealm/browser-adapter";
import { RuntimeClient, RuntimeHost } from "@virealm/runtime-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DesktopLog } from "../../src/main/logging.js";
import { JsonEnvironmentStore } from "../../src/main/persistence/environment-store.js";
import {
  startProbeServer,
  type ProbeServer,
} from "../../src/main/runtime/probe-server.js";
import { DesktopEnvironmentService } from "../../src/main/services/environment-service.js";
import { SafeProfileCleanup } from "../../src/main/services/profile-cleanup.js";
import type { EnvironmentDraft } from "../../src/shared/contracts.js";

const runtimeExecutable =
  process.env.VIREALM_RUNTIME_EXECUTABLE ??
  fileURLToPath(
    new URL("../../../../target/debug/virealm-runtime.exe", import.meta.url),
  );

const baseAvailable =
  process.platform === "win32" && existsSync(runtimeExecutable);

// Discovery needs no live runtime; the throwaway adapter only proves Chrome is
// installed before the harness declares itself available.
const probeAdapter = baseAvailable
  ? new BrowserAdapter({
      dataRoot: path.join(tmpdir(), "virealm-probe-unused"),
      runtimePipePath: String.raw`\\.\pipe\virealm-probe-${randomUUID()}`,
    })
  : undefined;

const chromeAvailable = probeAdapter?.discoverBrowsers()[0] !== undefined;
const available = baseAvailable && chromeAvailable;

if (!available) {
  console.warn(
    "[desktop integration] prerequisites missing; real Chrome tests are skipped:",
    {
      platform: process.platform,
      runtimeExecutable,
      runtimeExists: existsSync(runtimeExecutable),
      chromeFound: chromeAvailable,
    },
  );
}

interface Harness {
  readonly root: string;
  readonly dataRoot: string;
  readonly host: RuntimeHost;
  readonly client: RuntimeClient;
  readonly adapter: BrowserAdapter;
  readonly probe: ProbeServer;
  readonly service: DesktopEnvironmentService;
  readonly log: DesktopLog;
}

let harness: Harness | undefined;

beforeAll(async () => {
  if (!available) {
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "virealm-desktop-int-"));
  const dataRoot = path.join(root, "data");
  const pipePath = String.raw`\\.\pipe\virealm-desktop-int-${randomUUID().slice(0, 8)}`;
  const host = await RuntimeHost.start({
    executablePath: runtimeExecutable,
    pipePath,
    startupTimeoutMs: 20_000,
  });
  const client = new RuntimeClient({ pipePath });
  const probe = await startProbeServer();
  const adapter = new BrowserAdapter({
    dataRoot,
    runtime: client,
    networkProbeUrl: probe.url,
  });
  const log = new DesktopLog();
  const service = new DesktopEnvironmentService({
    store: new JsonEnvironmentStore(path.join(root, "environments.json")),
    adapter,
    dataRoot,
    cleanup: new SafeProfileCleanup(dataRoot),
    log,
    verifyTimeoutMs: 20_000,
  });
  await service.initialize();
  harness = { root, dataRoot, host, client, adapter, probe, service, log };
}, 120_000);

afterAll(async () => {
  const h = harness;
  if (h === undefined) {
    return;
  }
  try {
    const environments = await h.service.list().catch(() => []);
    await Promise.allSettled(
      environments
        .filter(
          (environment) =>
            environment.state === "running" ||
            environment.state === "starting" ||
            environment.state === "stopping",
        )
        .map((environment) => h.service.stop(environment.id, { force: true })),
    );
  } finally {
    await h.adapter.close().catch(() => undefined);
    h.client.close();
    await h.probe.close().catch(() => undefined);
    await h.host.stop().catch(() => undefined);
    await rm(h.root, { recursive: true, force: true }).catch(() => undefined);
  }
}, 120_000);

function platform(): Harness {
  if (harness === undefined) {
    throw new Error("integration harness is not initialized");
  }
  return harness;
}

describe("integration prerequisites", () => {
  it("has a Windows runtime binary and a local Chrome", () => {
    expect(process.platform).toBe("win32");
    expect(
      existsSync(runtimeExecutable),
      `build the runtime first: cargo build -p virealm-process-runtime --bin virealm-runtime (missing ${runtimeExecutable})`,
    ).toBe(true);
    expect(
      chromeAvailable,
      "Chrome was not found in a standard Windows install location",
    ).toBe(true);
  });
});

describe.skipIf(!available)("desktop with real runtime and Chrome", () => {
  it("manages two simultaneous isolated environments end to end", async () => {
    const h = platform();
    const chrome = h.adapter.discoverBrowsers()[0];
    expect(chrome).toBeDefined();
    if (chrome === undefined) {
      throw new Error("Chrome disappeared during the test");
    }

    const draft = (name: string, timezone: string): EnvironmentDraft => ({
      name,
      browser: { executablePath: chrome.executablePath },
      timezone,
      locale: "zh-CN",
      viewport: { width: 1280, height: 800 },
      runtimePolicy: { isolation: "managed" as const },
      launch: { additionalArguments: ["--headless=new"] },
    });

    const first = await h.service.create(draft("集成环境 A", "Asia/Shanghai"));
    const second = await h.service.create(
      draft("集成环境 B", "America/New_York"),
    );
    expect(first.dataDir).not.toBe(second.dataDir);
    expect(first.state).toBe("stopped");

    const [runningFirst, runningSecond] = await Promise.all([
      h.service.launch(first.id),
      h.service.launch(second.id),
    ]);
    expect(runningFirst.state).toBe("running");
    expect(runningSecond.state).toBe("running");
    expect(runningFirst.pid).toBeGreaterThan(0);
    expect(runningSecond.pid).toBeGreaterThan(0);
    expect(runningFirst.pid).not.toBe(runningSecond.pid);
    expect(runningFirst.cdp.connected).toBe(true);
    expect(runningSecond.cdp.connected).toBe(true);
    expect(runningFirst.browserVersion).toMatch(/^\d+\./u);
    expect(runningFirst.lastLaunch?.ok).toBe(true);
    expect(runningSecond.lastLaunch?.ok).toBe(true);
    expect((await stat(first.dataDir)).isDirectory()).toBe(true);
    expect((await stat(second.dataDir)).isDirectory()).toBe(true);

    const verification = runningFirst.verification;
    expect(verification).toBeDefined();
    expect(verification?.stale).toBe(false);
    const verified = (name: string): string | undefined =>
      verification?.fields.find((field) => field.field === name)?.status;
    expect(verified("timezone")).toBe("verified");
    expect(verified("locale")).toBe("verified");
    expect(verified("viewport")).toBe("verified");
    expect(
      verification?.fields.some((field) => field.status === "failed"),
    ).toBe(false);

    expect((await h.service.get(first.id)).state).toBe("running");
    expect(h.service.logsFor(first.id).length).toBeGreaterThan(0);

    const hot = await h.service.update(
      first.id,
      draft("集成环境 A", "Europe/Berlin"),
    );
    expect(hot.appliedFields).toContain("timezone");
    expect(hot.restartFields).toEqual([]);
    expect(hot.environment.pendingRestart).toBe(false);
    const observed = hot.environment.verification?.fields.find(
      (field) => field.field === "timezone",
    );
    expect(observed?.status).toBe("verified");
    expect(observed?.requested).toBe("Europe/Berlin");

    // A restart-required field: the running browser keeps the old Job Object
    // until the environment is restarted. The isolation mode is deliberately
    // not used here — the desktop refuses the modes Chromium cannot run in.
    const restart = await h.service.update(
      first.id,
      draftWithMaxProcesses("集成环境 A", "Europe/Berlin", 8),
    );
    expect(restart.restartFields).toContain("runtimePolicy.maxProcesses");
    expect(restart.environment.pendingRestart).toBe(true);

    const firstStopped = await h.service.stop(first.id, { force: false });
    const secondStopped = await h.service.stop(second.id, { force: true });
    expect(firstStopped.state).toBe("stopped");
    expect(secondStopped.state).toBe("stopped");
    expect(firstStopped.pid).toBeUndefined();
    expect(secondStopped.pid).toBeUndefined();
    expect(firstStopped.verification?.stale).toBe(true);

    // A fresh store and service stand in for the next desktop launch: records
    // are restored from disk, while runtime state is re-queried, not replayed.
    const restored = new DesktopEnvironmentService({
      store: new JsonEnvironmentStore(path.join(h.root, "environments.json")),
      adapter: h.adapter,
      dataRoot: h.dataRoot,
      cleanup: new SafeProfileCleanup(h.dataRoot),
      log: h.log,
      verifyTimeoutMs: 20_000,
    });
    const restoredList = await restored.list();
    expect(restoredList.map((environment) => environment.name)).toEqual([
      "集成环境 A",
      "集成环境 B",
    ]);
    expect(
      restoredList.every((environment) => environment.state === "stopped"),
    ).toBe(true);
    expect(
      restoredList.find((environment) => environment.id === first.id)
        ?.pendingRestart,
    ).toBe(false);
  }, 170_000);
});

function draftWithMaxProcesses(
  name: string,
  timezone: string,
  maxProcesses: number,
): {
  readonly name: string;
  readonly browser: { readonly executablePath: string };
  readonly timezone: string;
  readonly locale: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly runtimePolicy: {
    readonly isolation: "managed";
    readonly maxProcesses: number;
  };
  readonly launch: { readonly additionalArguments: readonly string[] };
} {
  const chrome = platform().adapter.discoverBrowsers()[0];
  return {
    name,
    browser: {
      executablePath: chrome?.executablePath ?? "C:\\missing-chrome.exe",
    },
    timezone,
    locale: "zh-CN",
    viewport: { width: 1280, height: 800 },
    runtimePolicy: { isolation: "managed", maxProcesses },
    launch: { additionalArguments: ["--headless=new"] },
  };
}
