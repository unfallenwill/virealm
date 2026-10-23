import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProcessStatus } from "@virealm/contracts";

import {
  createHarness,
  FakeDiscovery,
  FakePage,
  FakeSession,
  launchConfigPath,
  makeConfig,
  publishEndpoint,
  requireValue,
  supportedCapabilities,
  TEST_CHROME,
  userDataDirFrom,
  TEST_CHROME_VERSION,
  TEST_ENDPOINT,
  type Harness,
} from "./helpers/fakes.js";
import { BrowserAdapterError } from "../../src/domain/errors.js";
import type { PersistedRuntimeState } from "../../src/domain/status.js";

const harnesses: Harness[] = [];
const servers: Server[] = [];

function harness(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const created = createHarness(options);
  harnesses.push(created);
  return created;
}

function launched(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const created = harness(options);
  publishEndpoint(created.runtime);
  return created;
}

function secondService(source: Harness): Harness {
  return harness({
    dataRoot: source.dataRoot,
    runtime: source.runtime,
    connector: source.connector,
    discovery: source.discovery,
    store: source.store,
  });
}

afterEach(() => {
  for (const harnessInstance of harnesses.splice(0)) {
    rmSync(harnessInstance.root, { recursive: true, force: true });
  }
  for (const server of servers.splice(0)) {
    server.close();
  }
});

function persistedRunning(
  environmentId: string,
  overrides: Partial<PersistedRuntimeState> = {},
): PersistedRuntimeState {
  return {
    environmentId,
    processInstanceId: "999:133000000000000000",
    pid: 999,
    startedAtUnixMs: 1_700_000_000_000,
    userDataDir: path.join(
      "C:\\VirealmData",
      "environments",
      environmentId,
      "chrome-data",
    ),
    endpoint: "ws://127.0.0.1:1/devtools/browser/missing",
    browserVersion: "156.0.8078.48",
    state: "running",
    updatedAtUnixMs: 1_700_000_000_000,
    lastError: undefined,
    ...overrides,
  };
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

function statusOf(processInstanceId: string): ProcessStatus {
  return {
    processInstanceId,
    pid: 123,
    creationTime100ns: "133000000000000000",
    startedAtUnixMs: 1_700_000_000_000,
    state: { state: "running", pid: 123 },
    applied: {
      mode: "managed",
      jobObjectAttached: true,
      appContainerToken: false,
      restrictedToken: false,
      lowIntegrity: false,
      fileAccessRestricted: false,
      networkAccess: "allow",
      networkCapabilitiesVerified: true,
    },
  };
}

describe("launchEnvironment", () => {
  it("launches Chrome through the runtime and connects over CDP", async () => {
    const h = launched();
    const config = makeConfig({
      timezone: "Asia/Singapore",
      locale: "en-US",
      viewport: { width: 1_366, height: 768 },
    });

    const result = await h.service.launchEnvironment(config);

    expect(result.status.state).toBe("running");
    expect(result.status.cdp.connected).toBe(true);
    expect(result.status.cdp.endpoint).toBe(TEST_ENDPOINT);
    expect(result.status.userDataDir).toBe(launchConfigPath(h));
    expect(result.status.processInstanceId).toBeDefined();
    expect(result.config.fields.map((field) => field.field)).toEqual([
      "timezone",
      "locale",
      "acceptLanguage",
      "viewport",
    ]);
    expect(
      result.config.fields.every((field) => field.status === "applied"),
    ).toBe(true);

    expect(h.runtime.launches).toHaveLength(1);
    const launch = requireValue(h.runtime.launches[0]);
    expect(launch.executable).toBe(config.browser.executablePath);
    expect(launch.arguments).toContain(
      `--user-data-dir=${launchConfigPath(h)}`,
    );
    expect(launch.arguments).toContain("--remote-debugging-port=0");
    expect(launch.arguments).toContain("--remote-debugging-address=127.0.0.1");
    expect(launch.policy.isolation).toBe("managed");
    expect(launch.policy.containment.killOnClose).toBe(true);
    expect(launch.workingDirectory).toBe(
      path.join(h.dataRoot, "environments", "env_a"),
    );

    expect(
      existsSync(path.join(launchConfigPath(h), "virealm-profile.json")),
    ).toBe(true);
    const stored = h.store.entries.get("env_a");
    expect(stored?.state).toBe("running");
    expect(stored?.endpoint).toBe(TEST_ENDPOINT);
    expect(h.connector.endpoints).toEqual([TEST_ENDPOINT]);
  });

  it("forwards runtime limits and AppContainer file access", async () => {
    const h = launched();
    const config = makeConfig({
      runtimePolicy: {
        isolation: "app_container",
        maxProcesses: 12,
        memoryLimitBytes: 1_000_000,
      },
    });
    await h.service.launchEnvironment(config);
    const launch = requireValue(h.runtime.launches[0]);
    expect(launch.policy.isolation).toBe("app_container");
    if (launch.policy.isolation === "app_container") {
      expect(launch.policy.fileAccess.kind).toBe("restricted");
      expect(launch.policy.fileAccess.dataDirectory).toBe("read_write");
      expect(launch.policy.containment.maxProcesses).toBe(12);
      expect(launch.policy.containment.memoryLimitBytes).toBe(1_000_000);
    }
  });

  it("rejects an invalid configuration before creating a process", async () => {
    const h = harness();
    await expect(h.service.launchEnvironment({})).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    expect(h.runtime.launches).toEqual([]);
  });

  it("never downgrades an unsupported isolation mode", async () => {
    const h = harness();
    h.runtime.capabilities = supportedCapabilities({
      restrictedToken: { state: "unavailable", detail: "blocked" },
    });
    publishEndpoint(h.runtime);
    await expect(
      h.service.launchEnvironment(
        makeConfig({ runtimePolicy: { isolation: "restricted" } }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_isolation" });
    expect(h.runtime.launches).toEqual([]);
  });

  it("requires the AppContainer capability pair", async () => {
    const h = harness();
    h.runtime.capabilities = supportedCapabilities({
      appContainerAcl: { state: "not_verified" },
    });
    publishEndpoint(h.runtime);
    await expect(
      h.service.launchEnvironment(
        makeConfig({ runtimePolicy: { isolation: "app_container" } }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_isolation" });
  });

  it("refuses two environments that share one profile", async () => {
    const h = launched();
    const shared = path.join(h.dataRoot, "shared-profile");
    await h.service.launchEnvironment(
      makeConfig({
        browser: {
          ...makeConfig().browser,
          userDataDir: shared,
        },
      }),
    );
    await expect(
      h.service.launchEnvironment(
        makeConfig({
          id: "env_b",
          name: "B",
          browser: {
            ...makeConfig().browser,
            userDataDir: shared,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "data_directory_conflict" });
    expect(h.runtime.launches).toHaveLength(1);
  });

  it("refuses a second concurrent launch of one environment", async () => {
    const h = launched();
    const [first, second] = await Promise.allSettled([
      h.service.launchEnvironment(makeConfig()),
      h.service.launchEnvironment(makeConfig()),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toMatchObject({
        code: "environment_already_running",
      });
    }
    expect(h.runtime.launches).toHaveLength(1);
  });

  it("does not launch over a process the runtime still owns", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    const restarted = secondService(h);
    await expect(
      restarted.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "environment_already_running" });
  });

  it("recovers from a stale record whose process has exited", async () => {
    const h = launched();
    const first = await h.service.launchEnvironment(makeConfig());
    h.runtime.markExited(requireValue(first.status.processInstanceId), 0);

    const restarted = secondService(h);
    const second = await restarted.service.launchEnvironment(makeConfig());
    expect(second.status.state).toBe("running");
    expect(h.runtime.launches).toHaveLength(2);
  });

  it("terminates Chrome when the CDP connection fails", async () => {
    const h = launched();
    h.connector.connectError = new BrowserAdapterError("cdp_timeout", "no CDP");
    await expect(
      h.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "cdp_timeout" });

    expect(h.runtime.terminateCalls).toBe(1);
    expect(h.store.entries.get("env_a")?.state).toBe("failed");
    expect(h.store.entries.get("env_a")?.lastError?.code).toBe("cdp_timeout");
    await expect(
      h.service.getEnvironmentStatus("env_a"),
    ).resolves.toMatchObject({ state: "failed" });
  });

  it("verifies the CDP browser version against the discovered one", async () => {
    const h = launched();
    h.connector.sessionFactory = () => {
      const session = new FakeSession();
      session.versionValue = "1.2.3.4";
      return session;
    };
    await expect(
      h.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "chrome_incompatible" });
    expect(h.runtime.terminateCalls).toBe(1);
    expect(h.store.entries.get("env_a")?.lastError?.code).toBe(
      "chrome_incompatible",
    );
  });

  it("times out when Chrome never publishes a debugging endpoint", async () => {
    const h = harness({
      timeouts: { launchMs: 30, cdpConnectMs: 100 },
    });
    await expect(
      h.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "cdp_timeout" });
    expect(h.runtime.terminateCalls).toBe(1);
    expect(h.store.entries.get("env_a")?.state).toBe("failed");
  });

  it("reports a browser that exits during launch", async () => {
    const h = harness();
    h.runtime.onLaunch = (_params, status) => {
      h.runtime.markExited(status.processInstanceId, 3);
    };
    await expect(
      h.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "browser_exited" });
    expect(h.store.entries.get("env_a")?.state).toBe("failed");
  });

  it("explains a browser that aborts with STATUS_BREAKPOINT under a restricted token", async () => {
    const h = harness();
    h.runtime.onLaunch = (_params, status) => {
      h.runtime.markExited(status.processInstanceId, 0x80000003);
    };
    await expect(
      h.service.launchEnvironment(
        makeConfig({ runtimePolicy: { isolation: "restricted" } }),
      ),
    ).rejects.toMatchObject({
      code: "unsupported_isolation",
      details: { isolation: "restricted", exitCode: 0x80000003 },
    });
    expect(h.runtime.terminateCalls).toBe(1);
    expect(h.store.entries.get("env_a")?.state).toBe("failed");
  });

  it("explains a browser that aborts with STATUS_BREAKPOINT inside an AppContainer", async () => {
    const h = harness();
    h.runtime.onLaunch = (_params, status) => {
      h.runtime.markExited(status.processInstanceId, 0x80000003);
    };
    await expect(
      h.service.launchEnvironment(
        makeConfig({ runtimePolicy: { isolation: "app_container" } }),
      ),
    ).rejects.toMatchObject({
      code: "unsupported_isolation",
      details: { isolation: "app_container", exitCode: 0x80000003 },
    });
  });

  it("explains a browser that aborts with a build specific code under a restricted token", async () => {
    const h = harness();
    h.runtime.onLaunch = (_params, status) => {
      // Chromium reports a different abort code on other builds; the
      // classification must not depend on one magic number.
      h.runtime.markExited(status.processInstanceId, 0xc0000005);
    };
    await expect(
      h.service.launchEnvironment(
        makeConfig({ runtimePolicy: { isolation: "restricted" } }),
      ),
    ).rejects.toMatchObject({
      code: "unsupported_isolation",
      details: {
        isolation: "restricted",
        exitCode: 0xc0000005,
        reason: "early_exit_under_restricted_isolation",
      },
    });
  });

  it("keeps the generic failure for a managed browser that aborts", async () => {
    const h = harness();
    h.runtime.onLaunch = (_params, status) => {
      h.runtime.markExited(status.processInstanceId, 0x80000003);
    };
    await expect(
      h.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "browser_exited" });
  });

  it("maps runtime policy rejections to unsupported_isolation", async () => {
    const h = harness();
    h.runtime.launchError = new BrowserAdapterError(
      "runtime_operation_failed",
      "policy rejected",
      { contractCode: "policy_violation" },
    );
    await expect(
      h.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "unsupported_isolation" });
  });

  it("wraps an unexpected launch failure", async () => {
    const h = harness();
    h.runtime.launchError = new Error("socket exploded");
    await expect(
      h.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "launch_failed" });
  });

  it("propagates a runtime availability failure", async () => {
    const h = harness();
    h.runtime.capabilitiesError = new BrowserAdapterError(
      "runtime_unavailable",
      "runtime is down",
    );
    await expect(
      h.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(h.runtime.launches).toEqual([]);
  });
});

describe("status, disconnect and reconnect", () => {
  it("reports running with CDP disconnected without stopping Chrome", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    const session = requireValue(h.connector.sessions[0]);
    const profileFile = path.join(launchConfigPath(h), "Cookies");
    writeFileSync(profileFile, "keep-me");

    session.emitDisconnected();
    const status = await h.service.getEnvironmentStatus("env_a");

    expect(status.state).toBe("running");
    expect(status.cdp.connected).toBe(false);
    expect(status.cdp.endpoint).toBe(TEST_ENDPOINT);
    expect(h.runtime.terminateCalls).toBe(0);
    expect(readFileSync(profileFile, "utf8")).toBe("keep-me");
  });

  it("reconnects to the same browser without touching its profile", async () => {
    const h = launched();
    const config = makeConfig({ timezone: "Asia/Singapore" });
    await h.service.launchEnvironment(config);
    requireValue(h.connector.sessions[0]).emitDisconnected();

    const result = await h.service.connectEnvironment(config);

    expect(result.status.cdp.connected).toBe(true);
    expect(h.connector.sessions).toHaveLength(2);
    expect(h.runtime.launches).toHaveLength(1);
    expect(
      result.config.fields.find((field) => field.field === "timezone")?.status,
    ).toBe("applied");
  });

  it("reconnects after an adapter restart using the persisted endpoint", async () => {
    const h = launched();
    const config = makeConfig();
    const launchedState = await h.service.launchEnvironment(config);
    requireValue(h.connector.sessions[0]).emitDisconnected();

    const restarted = secondService(h);
    const status = await restarted.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("running");
    expect(status.cdp.connected).toBe(false);

    const result = await restarted.service.connectEnvironment(config);
    expect(result.status.cdp.connected).toBe(true);
    expect(result.status.processInstanceId).toBe(
      launchedState.status.processInstanceId,
    );
  });

  it("recovers the endpoint from DevToolsActivePort after a crash", async () => {
    const h = launched();
    const config = makeConfig();
    const result = await h.service.launchEnvironment(config);
    requireValue(h.connector.sessions[0]).emitDisconnected();
    h.store.entries.set("env_a", {
      ...requireValue(h.store.entries.get("env_a")),
      endpoint: undefined,
    });

    const restarted = secondService(h);
    const reconnected = await restarted.service.connectEnvironment(config);
    expect(reconnected.status.cdp.connected).toBe(true);
    expect(reconnected.status.processInstanceId).toBe(
      result.status.processInstanceId,
    );
  });

  it("refuses to reconnect with a different profile", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    requireValue(h.connector.sessions[0]).emitDisconnected();

    const other = makeConfig();
    h.store.entries.set("env_a", {
      ...requireValue(h.store.entries.get("env_a")),
      userDataDir: path.join(h.dataRoot, "other-profile"),
    });
    const restarted = secondService(h);
    await expect(
      restarted.service.connectEnvironment(other),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("reports an exited browser during reconnect and marks the record", async () => {
    const h = launched();
    const config = makeConfig();
    const result = await h.service.launchEnvironment(config);
    requireValue(h.connector.sessions[0]).emitDisconnected();
    h.runtime.markExited(requireValue(result.status.processInstanceId), 2);
    const restarted = secondService(h);

    await expect(
      restarted.service.connectEnvironment(config),
    ).rejects.toMatchObject({ code: "browser_exited" });
    expect(h.store.entries.get("env_a")?.state).toBe("failed");
  });

  it("reports an unreachable browser during reconnect", async () => {
    const h = harness();
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", {
        processInstanceId: "unknown:1",
        userDataDir: launchConfigPath(h),
      }),
    );
    await expect(
      h.service.connectEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "browser_exited" });
    expect(h.store.entries.get("env_a")?.state).toBe("stopped");
  });

  it("rejects a malformed recorded endpoint", async () => {
    const h = harness();
    h.runtime.statuses.set(
      "999:133000000000000000",
      statusOf("999:133000000000000000"),
    );
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", {
        userDataDir: path.join(
          h.dataRoot,
          "environments",
          "env_a",
          "chrome-data",
        ),
        endpoint: "not-a-url",
      }),
    );
    await expect(
      h.service.connectEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "cdp_disconnected" });
  });

  it("rejects a recorded endpoint that is not loopback", async () => {
    const h = harness();
    h.runtime.statuses.set(
      "999:133000000000000000",
      statusOf("999:133000000000000000"),
    );
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", {
        userDataDir: path.join(
          h.dataRoot,
          "environments",
          "env_a",
          "chrome-data",
        ),
        endpoint: "ws://10.0.0.5:9222/devtools/browser/external",
      }),
    );
    await expect(
      h.service.connectEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "cdp_disconnected" });
  });

  it("rejects a recorded endpoint for a browser other than a browser target", async () => {
    const h = harness();
    h.runtime.statuses.set(
      "999:133000000000000000",
      statusOf("999:133000000000000000"),
    );
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", {
        userDataDir: path.join(
          h.dataRoot,
          "environments",
          "env_a",
          "chrome-data",
        ),
        endpoint: "ws://127.0.0.1:9222/devtools/page/abc",
      }),
    );
    await expect(
      h.service.connectEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "cdp_disconnected" });
  });

  it("rejects reconnect when no runtime record exists", async () => {
    const h = harness();
    await expect(
      h.service.connectEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "environment_not_found" });
  });

  it("rejects reconnect when the record is stopped", async () => {
    const h = harness();
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", { state: "stopped" }),
    );
    await expect(
      h.service.connectEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "browser_exited" });
  });

  it("disconnects without terminating the browser and reconnects", async () => {
    const h = launched();
    const config = makeConfig();
    await h.service.launchEnvironment(config);

    const after = await h.service.disconnectEnvironment("env_a");
    expect(after.state).toBe("running");
    expect(after.cdp.connected).toBe(false);
    expect(h.runtime.terminateCalls).toBe(0);

    const again = await h.service.connectEnvironment(config);
    expect(again.status.cdp.connected).toBe(true);
  });

  it("disconnect is idempotent", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    await h.service.disconnectEnvironment("env_a");
    const second = await h.service.disconnectEnvironment("env_a");
    expect(second.cdp.connected).toBe(false);
  });

  it("reports unknown environments", async () => {
    const h = harness();
    await expect(
      h.service.getEnvironmentStatus("missing"),
    ).rejects.toMatchObject({ code: "environment_not_found" });
    await expect(
      h.service.disconnectEnvironment("missing"),
    ).rejects.toMatchObject({ code: "environment_not_found" });
  });

  it("disconnectAll releases CDP and leaves processes running", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    const session = requireValue(h.connector.sessions[0]);
    await h.service.disconnectAll();
    expect(session.isConnected()).toBe(false);
    expect(h.runtime.terminateCalls).toBe(0);
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("running");
    expect(status.cdp.connected).toBe(false);
  });
});

describe("getEnvironmentStatus reconciliation", () => {
  it("reports a process that exited unexpectedly as failed", async () => {
    const h = launched();
    const result = await h.service.launchEnvironment(makeConfig());
    h.runtime.markExited(requireValue(result.status.processInstanceId), 7);

    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("failed");
    expect(status.cdp.connected).toBe(false);
    expect(status.lastError?.code).toBe("browser_exited");
    expect(h.store.entries.get("env_a")?.state).toBe("failed");
    expect(existsSync(launchConfigPath(h))).toBe(true);
  });

  it("treats a clean unexpected exit as stopped", async () => {
    const h = launched();
    const result = await h.service.launchEnvironment(makeConfig());
    h.runtime.markExited(requireValue(result.status.processInstanceId), 0);
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("stopped");
  });

  it("reports a dead process whose runtime record vanished as failed", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    h.runtime.statuses.clear();
    const session = requireValue(h.connector.sessions[0]);
    session.emitDisconnected();

    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("failed");
  });

  it("reconciles persisted running state through the runtime", async () => {
    const h = harness();
    h.runtime.statuses.set(
      "999:133000000000000000",
      statusOf("999:133000000000000000"),
    );
    h.store.entries.set("env_a", persistedRunning("env_a"));
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("running");
    expect(status.cdp.connected).toBe(false);
  });

  it("repairs a stopping record whose process is still running", async () => {
    const h = harness();
    h.runtime.statuses.set(
      "999:133000000000000000",
      statusOf("999:133000000000000000"),
    );
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", { state: "stopping" }),
    );
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("running");
    expect(h.store.entries.get("env_a")?.state).toBe("running");
  });

  it("reports persisted starting state while the runtime is starting", async () => {
    const h = harness();
    h.runtime.statuses.set("999:133000000000000000", {
      ...statusOf("999:133000000000000000"),
      state: { state: "starting" },
    });
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", { state: "starting" }),
    );
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("starting");
  });

  it("marks a persisted record stopped when its process is gone and CDP is unreachable", async () => {
    const h = harness();
    h.store.entries.set("env_a", persistedRunning("env_a"));
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("stopped");
    expect(h.store.entries.get("env_a")?.state).toBe("stopped");
  });

  it("reports a persisted process that exited as failed", async () => {
    const h = harness();
    h.store.entries.set("env_a", persistedRunning("env_a"));
    h.runtime.statuses.set("999:133000000000000000", {
      ...statusOf("999:133000000000000000"),
      state: { state: "exited", exitCode: 5 },
    });
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("failed");
    expect(status.lastError?.code).toBe("browser_exited");
  });

  it("keeps a persisted stopped record untouched", async () => {
    const h = harness();
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", { state: "stopped", endpoint: undefined }),
    );
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("stopped");
  });
});

describe("apply and verify configuration", () => {
  it("applies a live configuration change to every page", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    const report = await h.service.applyEnvironmentConfig(
      "env_a",
      makeConfig({
        timezone: "America/Los_Angeles",
        locale: "en-GB",
        viewport: { width: 800, height: 600 },
      }),
    );
    expect(
      report.fields.find((field) => field.field === "timezone")?.requested,
    ).toBe("America/Los_Angeles");
    const page = requireValue(
      requireValue(h.connector.sessions[0]).pagesList[0],
    );
    expect(page.timezone).toBe("America/Los_Angeles");
    expect(page.viewport.width).toBe(800);
  });

  it("refuses to change the profile of a running environment", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    const changed = makeConfig({
      browser: {
        ...makeConfig().browser,
        userDataDir: path.join(h.dataRoot, "other-profile"),
      },
    });
    await expect(
      h.service.applyEnvironmentConfig("env_a", changed),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("refuses to apply a configuration for another environment id", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    await expect(
      h.service.applyEnvironmentConfig(
        "env_a",
        makeConfig({ id: "env_b", name: "B" }),
      ),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("reports not connected when applying after disconnect", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    await h.service.disconnectEnvironment("env_a");
    await expect(
      h.service.applyEnvironmentConfig("env_a"),
    ).rejects.toMatchObject({ code: "cdp_disconnected" });
    await expect(
      h.service.verifyEnvironmentConfig("env_a"),
    ).rejects.toMatchObject({ code: "cdp_disconnected" });
  });

  it("reports unknown environments when applying", async () => {
    const h = harness();
    await expect(
      h.service.applyEnvironmentConfig("missing"),
    ).rejects.toMatchObject({ code: "environment_not_found" });
  });

  it("verifies configuration with a controlled network probe", async () => {
    const h = launched();
    await h.service.launchEnvironment(
      makeConfig({ timezone: "Asia/Singapore", locale: "en-GB" }),
    );
    const report = await h.service.verifyEnvironmentConfig("env_a", undefined, {
      networkProbeUrl: "http://127.0.0.1:9/headers",
    });
    expect(
      report.fields.find((field) => field.field === "timezone")?.status,
    ).toBe("verified");
    expect(
      report.fields.find((field) => field.field === "acceptLanguage")?.status,
    ).toBe("verified");
  });

  it("verifies with the configured default probe", async () => {
    const h = launched({ networkProbeUrl: "http://127.0.0.1:9/headers" });
    await h.service.launchEnvironment(makeConfig({ locale: "en-US" }));
    const report = await h.service.verifyEnvironmentConfig("env_a");
    expect(
      report.fields.find((field) => field.field === "acceptLanguage")?.status,
    ).toBe("verified");
  });
});

describe("pages and targets", () => {
  it("lists, opens, navigates and closes pages", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig({ timezone: "Asia/Tokyo" }));

    const initial = h.service.listPages("env_a");
    expect(initial).toHaveLength(1);

    const opened = await h.service.openPage(
      "env_a",
      "http://127.0.0.1:8080/second",
    );
    expect(opened.url).toBe("http://127.0.0.1:8080/second");
    expect(h.service.listPages("env_a")).toHaveLength(2);
    const openedPage = requireValue(
      requireValue(h.connector.sessions[0]).pagesList[1],
    );
    expect(openedPage.timezone).toBe("Asia/Tokyo");

    const navigated = await h.service.navigatePage(
      "env_a",
      opened.pageId,
      "http://127.0.0.1:8080/third",
    );
    expect(navigated.url).toBe("http://127.0.0.1:8080/third");

    await h.service.closePage("env_a", opened.pageId);
    expect(h.service.listPages("env_a")).toHaveLength(1);
  });

  it("applies configuration to pages opened by the browser", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig({ timezone: "Asia/Tokyo" }));
    const session = requireValue(h.connector.sessions[0]);
    const page = new FakePage("page-extra", "http://127.0.0.1:8080/popup");
    session.emitPage(page);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.timezone).toBe("Asia/Tokyo");
  });

  it("rejects invalid URLs and unknown pages", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    await expect(
      h.service.openPage("env_a", "file:///C:/secret"),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(
      h.service.navigatePage("env_a", "page-1", "javascript:alert(1)"),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(
      h.service.navigatePage("env_a", "missing", "http://127.0.0.1:8080/"),
    ).rejects.toMatchObject({ code: "target_not_found" });
    await expect(h.service.closePage("env_a", "missing")).rejects.toMatchObject(
      { code: "target_not_found" },
    );
  });

  it("reports not connected when a page operation runs without CDP", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    await h.service.disconnectEnvironment("env_a");
    expect(() => h.service.listPages("env_a")).toThrow(
      expect.objectContaining({ code: "cdp_disconnected" }),
    );
    await expect(
      h.service.openPage("env_a", "about:blank"),
    ).rejects.toMatchObject({ code: "cdp_disconnected" });
  });

  it("reports unknown environments for page operations", () => {
    const h = harness();
    expect(() => h.service.listPages("missing")).toThrow(
      expect.objectContaining({ code: "environment_not_found" }),
    );
  });
});

describe("stopEnvironment", () => {
  it("closes Chrome gracefully and keeps the profile", async () => {
    const h = launched();
    const result = await h.service.launchEnvironment(makeConfig());
    const instanceId = requireValue(result.status.processInstanceId);
    const session = requireValue(h.connector.sessions[0]);
    session.onBrowserClose = () => {
      h.runtime.markExited(instanceId, 0);
    };
    writeFileSync(path.join(launchConfigPath(h), "Cookies"), "persist");

    const status = await h.service.stopEnvironment("env_a", {
      mode: "graceful",
      timeoutMs: 1_000,
    });

    expect(status.state).toBe("stopped");
    expect(status.cdp.connected).toBe(false);
    expect(session.commands.map((command) => command.method)).toContain(
      "Browser.close",
    );
    expect(h.runtime.terminateCalls).toBe(0);
    expect(
      readFileSync(path.join(launchConfigPath(h), "Cookies"), "utf8"),
    ).toBe("persist");
    expect(h.store.entries.get("env_a")?.state).toBe("stopped");
    expect(existsSync(path.join(launchConfigPath(h), "Cookies"))).toBe(true);
  });

  it("escalates to the runtime when Chrome ignores Browser.close", async () => {
    const h = launched({
      timeouts: { stopMs: 20 },
    });
    await h.service.launchEnvironment(makeConfig());
    const status = await h.service.stopEnvironment("env_a");
    expect(status.state).toBe("stopped");
    expect(h.runtime.terminateCalls).toBe(1);
  });

  it("force-terminates through the runtime without a CDP close request", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    const session = requireValue(h.connector.sessions[0]);
    const status = await h.service.stopEnvironment("env_a", {
      mode: "force",
    });
    expect(status.state).toBe("stopped");
    expect(h.runtime.terminateCalls).toBe(1);
    expect(session.commands).toEqual([]);
  });

  it("stops a process after an adapter restart", async () => {
    const h = launched();
    const result = await h.service.launchEnvironment(makeConfig());
    const restarted = secondService(h);

    const status = await restarted.service.stopEnvironment("env_a", {
      mode: "force",
    });
    expect(status.state).toBe("stopped");
    expect(h.runtime.terminateCalls).toBe(1);
    expect(
      h.runtime.statuses.get(requireValue(result.status.processInstanceId))
        ?.state.state,
    ).toBe("exited");
  });

  it("marks a record stopped when the runtime no longer owns it", async () => {
    const h = harness();
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", { processInstanceId: "gone:1" }),
    );
    const status = await h.service.stopEnvironment("env_a", {
      mode: "force",
    });
    expect(status.state).toBe("stopped");
    expect(h.store.entries.get("env_a")?.state).toBe("stopped");
  });

  it("closes an orphaned browser through its CDP endpoint", async () => {
    const h = harness();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ Browser: "Fake" }));
    });
    const port = await listen(server);
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", {
        processInstanceId: "gone:1",
        endpoint: `ws://127.0.0.1:${String(port)}/devtools/browser/orphan`,
      }),
    );
    h.connector.sessionFactory = () => {
      const session = new FakeSession();
      session.onBrowserClose = () => {
        server.close();
      };
      return session;
    };

    const status = await h.service.stopEnvironment("env_a", {
      mode: "force",
      timeoutMs: 1_000,
    });
    expect(status.state).toBe("stopped");
    expect(h.connector.sessions).toHaveLength(1);
  });

  it("reports a timeout when an orphaned browser will not close", async () => {
    const h = harness({
      timeouts: { stopMs: 120, endpointProbeMs: 50 },
    });
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const port = await listen(server);
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", {
        processInstanceId: "gone:1",
        endpoint: `ws://127.0.0.1:${String(port)}/devtools/browser/orphan`,
      }),
    );
    await expect(
      h.service.stopEnvironment("env_a", {
        mode: "force",
        timeoutMs: 120,
      }),
    ).rejects.toMatchObject({ code: "cdp_timeout" });
  });

  it("is idempotent for a stopped record and rejects unknown ids", async () => {
    const h = harness();
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", { state: "stopped", endpoint: undefined }),
    );
    const status = await h.service.stopEnvironment("env_a");
    expect(status.state).toBe("stopped");
    await expect(h.service.stopEnvironment("missing")).rejects.toMatchObject({
      code: "environment_not_found",
    });
  });

  it("terminates a persisted starting process", async () => {
    const h = harness();
    h.runtime.statuses.set(
      "999:133000000000000000",
      statusOf("999:133000000000000000"),
    );
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", { state: "starting" }),
    );
    const status = await h.service.stopEnvironment("env_a", {
      mode: "force",
    });
    expect(status.state).toBe("stopped");
    expect(h.runtime.terminateCalls).toBe(1);
  });
});

describe("public discovery and validation", () => {
  it("returns discovered browsers", () => {
    const h = harness();
    expect(h.service.discoverBrowsers()).toHaveLength(1);
    expect(h.service.discoverBrowsers("C:\\missing\\chrome.exe")).toEqual([]);
  });

  it("returns validation issues without throwing", () => {
    const h = harness();
    const result = h.service.validateEnvironment({ id: "bad id" });
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe("runtime failure handling", () => {
  it("propagates a runtime IPC failure from status", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    h.runtime.statusError = new BrowserAdapterError(
      "runtime_unavailable",
      "runtime went away",
    );
    await expect(h.service.getEnvironmentStatus("env_a")).rejects.toMatchObject(
      { code: "runtime_unavailable" },
    );
  });

  it("errors when the runtime does not know a persisted process", async () => {
    const h = harness();
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", { processInstanceId: "gone:1" }),
    );
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("stopped");
  });
});

describe("phase reports and process recovery", () => {
  async function versionServer(status = 200): Promise<number> {
    return listen(
      createServer((_request, response) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ Browser: "Fake/156" }));
      }),
    );
  }

  it("reports starting while a launch is waiting for the runtime", async () => {
    const h = harness();
    publishEndpoint(h.runtime);
    let release: () => void = () => undefined;
    h.runtime.capabilitiesGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.runtime.capabilitiesHook = entered;

    const launching = h.service.launchEnvironment(makeConfig());
    await reached;
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("starting");
    expect(status.processInstanceId).toBeUndefined();

    release();
    await launching;
  });

  it("reports stopping while the runtime terminates the browser", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    let release: () => void = () => undefined;
    h.runtime.terminateGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.runtime.terminateHook = entered;

    const stopping = h.service.stopEnvironment("env_a", { mode: "force" });
    await reached;
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("stopping");

    release();
    await stopping;
  });

  it("reports running while CDP is still connected but the runtime lost the process", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    h.runtime.statuses.clear();
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("running");
    expect(status.cdp.connected).toBe(true);
  });

  it("reports running when the endpoint still answers after the runtime lost the process", async () => {
    const h = harness();
    const port = await versionServer();
    publishEndpoint(h.runtime, port);
    await h.service.launchEnvironment(makeConfig());
    requireValue(h.connector.sessions[0]).emitDisconnected();
    h.runtime.statuses.clear();

    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("running");
    expect(status.cdp.connected).toBe(false);
  });

  it("reports starting when the runtime is starting the browser", async () => {
    const h = launched();
    const result = await h.service.launchEnvironment(makeConfig());
    h.runtime.statuses.set(requireValue(result.status.processInstanceId), {
      ...statusOf(requireValue(result.status.processInstanceId)),
      state: { state: "starting" },
    });
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("starting");
  });

  it("repairs persisted starting state from a live endpoint", async () => {
    const h = harness();
    const port = await versionServer();
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", {
        processInstanceId: "gone:1",
        endpoint: `ws://127.0.0.1:${String(port)}/devtools/browser/x`,
        state: "starting",
      }),
    );
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("running");
    expect(h.store.entries.get("env_a")?.state).toBe("running");
  });

  it("keeps a persisted running state whose endpoint answers", async () => {
    const h = harness();
    const port = await versionServer();
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", {
        processInstanceId: "gone:1",
        endpoint: `ws://127.0.0.1:${String(port)}/devtools/browser/x`,
      }),
    );
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("running");
  });

  it("does not probe a non-loopback persisted endpoint", async () => {
    const h = harness();
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", {
        processInstanceId: "gone:1",
        endpoint: "http://10.0.0.5:9222/json/version",
      }),
    );
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("stopped");
  });

  it("treats a failing endpoint probe as unreachable", async () => {
    const h = harness();
    const port = await versionServer(500);
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", {
        processInstanceId: "gone:1",
        endpoint: `ws://127.0.0.1:${String(port)}/devtools/browser/x`,
      }),
    );
    const status = await h.service.getEnvironmentStatus("env_a");
    expect(status.state).toBe("stopped");
  });

  it("reports a launch failure when the runtime did not start Chrome", async () => {
    const h = harness();
    h.runtime.launchState = "starting";
    await expect(
      h.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "launch_failed" });
    expect(h.runtime.terminateCalls).toBe(1);
    expect(h.store.entries.get("env_a")?.state).toBe("failed");
  });

  it("detects the runtime losing the process during launch", async () => {
    const h = harness({ timeouts: { launchMs: 60 } });
    h.runtime.onLaunch = () => {
      h.runtime.statuses.clear();
    };
    await expect(
      h.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "browser_exited" });
    expect(h.store.entries.get("env_a")?.state).toBe("failed");
  });

  it("rejects an endpoint that is not a browser target", async () => {
    const h = harness();
    h.runtime.onLaunch = (params) => {
      const userDataDir = userDataDirFrom(params);
      if (userDataDir !== undefined) {
        mkdirSync(userDataDir, { recursive: true });
        writeFileSync(
          path.join(userDataDir, "DevToolsActivePort"),
          "45678\n/devtools/page/abc\n",
          "utf8",
        );
      }
    };
    await expect(
      h.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("refuses to launch over a runtime that is still starting the browser", async () => {
    const h = harness();
    h.runtime.statuses.set("999:133000000000000000", {
      ...statusOf("999:133000000000000000"),
      state: { state: "starting" },
    });
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", { userDataDir: launchConfigPath(h) }),
    );
    await expect(
      h.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "environment_already_running" });
  });

  it("refuses to launch over a live debugging endpoint without a runtime record", async () => {
    const h = harness();
    const port = await versionServer();
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", {
        processInstanceId: "gone:1",
        endpoint: `ws://127.0.0.1:${String(port)}/devtools/browser/live`,
        userDataDir: launchConfigPath(h),
      }),
    );
    await expect(
      h.service.launchEnvironment(makeConfig()),
    ).rejects.toMatchObject({ code: "environment_already_running" });
  });

  it("recovers a stale record whose runtime process already exited", async () => {
    const h = harness();
    h.runtime.statuses.set("gone:1", {
      ...statusOf("gone:1"),
      state: { state: "exited", exitCode: 0 },
    });
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", {
        processInstanceId: "gone:1",
        userDataDir: launchConfigPath(h),
        endpoint: undefined,
      }),
    );
    publishEndpoint(h.runtime);

    const result = await h.service.launchEnvironment(makeConfig());
    expect(result.status.state).toBe("running");
    expect(h.runtime.launches).toHaveLength(1);
  });

  it("stops a persisted record whose process already exited", async () => {
    const h = harness();
    h.runtime.statuses.set("gone:1", {
      ...statusOf("gone:1"),
      state: { state: "exited", exitCode: 0 },
    });
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", { processInstanceId: "gone:1" }),
    );
    const status = await h.service.stopEnvironment("env_a");
    expect(status.state).toBe("stopped");
    expect(h.runtime.terminateCalls).toBe(0);
  });

  it("escalates when Browser.close fails", async () => {
    const h = launched({ timeouts: { stopMs: 20 } });
    await h.service.launchEnvironment(makeConfig());
    requireValue(h.connector.sessions[0]).browserCommandError = new Error(
      "socket closed",
    );
    const status = await h.service.stopEnvironment("env_a", {
      mode: "graceful",
    });
    expect(status.state).toBe("stopped");
    expect(h.runtime.terminateCalls).toBe(1);
  });

  it("treats a vanished runtime process as exited after Browser.close", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    const session = requireValue(h.connector.sessions[0]);
    session.onBrowserClose = () => {
      h.runtime.statuses.clear();
    };
    const status = await h.service.stopEnvironment("env_a", {
      mode: "graceful",
      timeoutMs: 500,
    });
    expect(status.state).toBe("stopped");
    expect(h.runtime.terminateCalls).toBe(0);
  });

  it("times out when the orphaned browser cannot be reached over CDP", async () => {
    const h = harness({ timeouts: { stopMs: 100, endpointProbeMs: 50 } });
    const port = await versionServer();
    h.store.entries.set(
      "env_a",
      persistedRunning("env_a", {
        processInstanceId: "gone:1",
        endpoint: `ws://127.0.0.1:${String(port)}/devtools/browser/orphan`,
      }),
    );
    h.connector.connectError = new Error("connection refused");
    await expect(
      h.service.stopEnvironment("env_a", {
        mode: "force",
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "cdp_timeout" });
  });

  it("force-stops without CDP after a disconnect", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    await h.service.disconnectEnvironment("env_a");
    const status = await h.service.stopEnvironment("env_a", {
      mode: "force",
    });
    expect(status.state).toBe("stopped");
    expect(h.runtime.terminateCalls).toBe(1);
  });

  it("reuses an existing CDP connection on connect", async () => {
    const h = launched();
    const config = makeConfig();
    await h.service.launchEnvironment(config);
    const result = await h.service.connectEnvironment(config);
    expect(result.status.cdp.connected).toBe(true);
    expect(h.connector.sessions).toHaveLength(1);
  });

  it("launches two environments with separate profiles", async () => {
    const h = launched();
    const first = await h.service.launchEnvironment(makeConfig());
    const second = await h.service.launchEnvironment(
      makeConfig({ id: "env_b", name: "Environment B" }),
    );
    expect(first.status.state).toBe("running");
    expect(second.status.state).toBe("running");
    expect(first.status.userDataDir).not.toBe(second.status.userDataDir);
    expect(h.runtime.launches).toHaveLength(2);
  });

  it("skips version comparison when discovery reports an unknown version", async () => {
    const h = harness({
      discovery: new FakeDiscovery([
        { executablePath: TEST_CHROME, version: "unknown", source: "test" },
      ]),
    });
    publishEndpoint(h.runtime);
    const config = makeConfig();
    const result = await h.service.launchEnvironment({
      ...config,
      browser: { executablePath: TEST_CHROME },
    });
    expect(result.status.browserVersion).toBe(TEST_CHROME_VERSION);
  });

  it("propagates unexpected runtime status failures", async () => {
    const h = launched();
    await h.service.launchEnvironment(makeConfig());
    h.runtime.statusError = new BrowserAdapterError(
      "runtime_operation_failed",
      "unexpected",
      { contractCode: "something_else" },
    );
    await expect(h.service.getEnvironmentStatus("env_a")).rejects.toMatchObject(
      { code: "runtime_operation_failed" },
    );
  });
});
