import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserAdapter } from "../../src/browser-adapter.js";
import { JsonRuntimeStateStore } from "../../src/persistence/runtime-state-store.js";
import {
  FakeConnector,
  FakeDiscovery,
  FakeRuntime,
  makeConfig,
  MemoryStateStore,
  publishEndpoint,
  requireValue,
} from "./helpers/fakes.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "virealm-facade-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function adapterWithFakes(): {
  readonly adapter: BrowserAdapter;
  readonly runtime: FakeRuntime;
  readonly connector: FakeConnector;
  readonly discovery: FakeDiscovery;
  readonly store: MemoryStateStore;
  readonly dataRoot: string;
} {
  const dataRoot = path.join(makeRoot(), "data");
  const runtime = new FakeRuntime();
  const connector = new FakeConnector();
  const discovery = new FakeDiscovery();
  const store = new MemoryStateStore();
  publishEndpoint(runtime);
  const adapter = new BrowserAdapter({
    dataRoot,
    runtime,
    connector,
    discovery,
    stateStore: store,
    localAppData: path.join(makeRoot(), "local-app-data"),
    timeouts: { launchMs: 5_000 },
    now: () => 1_700_000_000_000,
  });
  return { adapter, runtime, connector, discovery, store, dataRoot };
}

describe("BrowserAdapter public interface", () => {
  it("forwards the whole lifecycle through the environment service", async () => {
    const { adapter, runtime, connector, dataRoot } = adapterWithFakes();
    const config = makeConfig({ timezone: "Asia/Singapore" });

    expect(adapter.discoverBrowsers()).toHaveLength(1);
    expect(adapter.discoverBrowsers("C:\\missing\\chrome.exe")).toEqual([]);
    expect(adapter.validateEnvironment(config).valid).toBe(true);

    const launched = await adapter.launchEnvironment(config);
    expect(launched.status.state).toBe("running");
    expect(launched.status.userDataDir).toBe(
      path.join(dataRoot, "environments", "env_a", "chrome-data"),
    );

    expect((await adapter.getEnvironmentStatus("env_a")).state).toBe("running");

    const pages = await adapter.listPages("env_a");
    expect(pages).toHaveLength(1);
    const first = requireValue(pages[0]);
    const opened = await adapter.openPage(
      "env_a",
      "http://127.0.0.1:8080/second",
    );
    expect(opened.url).toBe("http://127.0.0.1:8080/second");
    const navigated = await adapter.navigatePage(
      "env_a",
      opened.pageId,
      "http://127.0.0.1:8080/third",
    );
    expect(navigated.url).toBe("http://127.0.0.1:8080/third");
    await adapter.closePage("env_a", opened.pageId);
    expect(await adapter.listPages("env_a")).toHaveLength(1);
    expect(first.pageId).toBeDefined();

    const applied = await adapter.applyEnvironmentConfig("env_a", config);
    expect(applied.fields.length).toBeGreaterThan(0);
    const verified = await adapter.verifyEnvironmentConfig("env_a");
    expect(
      verified.fields.find((field) => field.field === "timezone")?.status,
    ).toBe("verified");

    await adapter.disconnectEnvironment("env_a");
    expect((await adapter.getEnvironmentStatus("env_a")).cdp.connected).toBe(
      false,
    );
    const reconnected = await adapter.connectEnvironment(config);
    expect(reconnected.status.cdp.connected).toBe(true);

    const stopped = await adapter.stopEnvironment("env_a", {
      mode: "force",
    });
    expect(stopped.state).toBe("stopped");
    expect(runtime.terminateCalls).toBe(1);
    expect(connector.sessions.length).toBeGreaterThanOrEqual(2);

    await adapter.close();
  });

  it("defaults to a JSON state store under the data root", async () => {
    const dataRoot = path.join(makeRoot(), "data");
    const runtime = new FakeRuntime();
    publishEndpoint(runtime);
    const adapter = new BrowserAdapter({
      dataRoot,
      runtime,
      connector: new FakeConnector(),
      discovery: new FakeDiscovery(),
      localAppData: path.join(makeRoot(), "local-app-data"),
    });

    await adapter.launchEnvironment(makeConfig());
    const store = new JsonRuntimeStateStore(dataRoot);
    expect((await store.read("env_a"))?.state).toBe("running");
    expect(existsSync(store.filePath)).toBe(true);

    await adapter.stopEnvironment("env_a", { mode: "force" });
    await adapter.close();
  });

  it("uses the real Chrome discovery when none is injected", async () => {
    const adapter = new BrowserAdapter({
      dataRoot: path.join(makeRoot(), "data"),
      runtime: new FakeRuntime(),
      chromeSearchPaths: ["C:\\missing\\Chrome for Testing\\chrome.exe"],
      localAppData: path.join(makeRoot(), "local-app-data"),
    });
    expect(Array.isArray(adapter.discoverBrowsers())).toBe(true);
    expect(
      adapter
        .discoverBrowsers("C:\\missing\\chrome.exe")
        .every((browser) => browser.source !== "explicit"),
    ).toBe(true);
    await adapter.close();
  });

  it("owns a runtime client when none is injected", async () => {
    const adapter = new BrowserAdapter({
      dataRoot: path.join(makeRoot(), "data"),
      runtimePipePath: `\\\\.\\pipe\\virealm-facade-${String(process.pid)}`,
      discovery: new FakeDiscovery(),
      localAppData: path.join(makeRoot(), "local-app-data"),
    });
    await adapter.close();
  });

  it("uses the process LOCALAPPDATA when no override is supplied", async () => {
    const previous = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      const adapter = new BrowserAdapter({
        dataRoot: path.join(makeRoot(), "data"),
        runtime: new FakeRuntime(),
        discovery: new FakeDiscovery(),
      });
      await adapter.close();

      process.env.LOCALAPPDATA = "C:\\Users\\Fake\\AppData\\Local";
      const second = new BrowserAdapter({
        dataRoot: path.join(makeRoot(), "data"),
        runtime: new FakeRuntime(),
        discovery: new FakeDiscovery(),
      });
      await second.close();
    } finally {
      if (previous === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = previous;
      }
    }
  });
});
