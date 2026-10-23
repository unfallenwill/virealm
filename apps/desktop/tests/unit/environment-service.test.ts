import {
  BrowserAdapterError,
  type BrowserEnvironmentConfig,
  type LaunchResult,
} from "@virealm/browser-adapter";
import { describe, expect, it, vi } from "vitest";

import { DesktopError } from "../../src/main/errors.js";
import { DesktopLog } from "../../src/main/logging.js";
import {
  DesktopEnvironmentService,
  changedFields,
  toAdapterConfig,
} from "../../src/main/services/environment-service.js";
import { expectedProfileDir } from "../../src/main/services/profile-cleanup.js";
import {
  TEST_DATA_ROOT,
  FakeAdapter,
  FakeCleanup,
  MemoryEnvironmentStore,
  draftFor,
  recordFor,
  reportFor,
  runningStatus,
  stoppedStatus,
} from "./helpers/fakes.js";

interface Harness {
  readonly service: DesktopEnvironmentService;
  readonly adapter: FakeAdapter;
  readonly store: MemoryEnvironmentStore;
  readonly cleanup: FakeCleanup;
  readonly log: DesktopLog;
  readonly dataRoot: string;
}

function setup(options: { readonly ids?: readonly string[] } = {}): Harness {
  const dataRoot = TEST_DATA_ROOT;
  const adapter = new FakeAdapter();
  const store = new MemoryEnvironmentStore();
  const cleanup = new FakeCleanup();
  const ids = [...(options.ids ?? ["env-created"])];
  let clock = 1_000;
  const log = new DesktopLog(() => clock, 500);
  const service = new DesktopEnvironmentService({
    store,
    adapter,
    dataRoot,
    cleanup,
    log,
    now: () => {
      clock += 1;
      return clock;
    },
    createId: () => {
      const next = ids.shift();
      if (next === undefined) {
        throw new Error("no more ids");
      }
      return next;
    },
    verifyTimeoutMs: 3_000,
  });
  return { service, adapter, store, cleanup, log, dataRoot };
}

function seed(harness: Harness, record = recordFor()): void {
  harness.store.records.push(record);
}

function withStatus(harness: Harness, id = "env-test"): void {
  harness.adapter.statuses.set(id, runningStatus(id));
}

function configOf(value: unknown): BrowserEnvironmentConfig {
  return value as BrowserEnvironmentConfig;
}

function deferredLaunch(): {
  readonly promise: Promise<LaunchResult>;
  readonly resolve: (value: LaunchResult) => void;
} {
  let resolve: (value: LaunchResult) => void = () => undefined;
  const promise = new Promise<LaunchResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("DesktopEnvironmentService create", () => {
  it("creates a stopped environment with a managed data directory", async () => {
    const harness = setup();
    const view = await harness.service.create(draftFor());

    expect(view).toMatchObject({
      id: "env-created",
      state: "stopped",
      name: "测试环境",
      pendingRestart: false,
      dataDir: expectedProfileDir(harness.dataRoot, "env-created"),
      browserVersion: "156.0.0.0",
      cdp: { connected: false },
      warnings: [],
    });
    expect(await harness.store.get("env-created")).toMatchObject({
      createdAtUnixMs: 1_001,
      updatedAtUnixMs: 1_001,
    });
    expect(harness.log.list()[0]?.code).toBe("environment_created");
  });

  it.each(["restricted", "app_container"] as const)(
    "refuses to create a Chrome environment with %s isolation",
    async (isolation) => {
      const harness = setup();
      await expect(
        harness.service.create(draftFor({ runtimePolicy: { isolation } })),
      ).rejects.toMatchObject({ code: "unsupported_isolation" });
      expect(harness.store.records).toHaveLength(0);
    },
  );

  it("rejects a configuration the adapter considers invalid", async () => {
    const harness = setup();
    harness.adapter.validation = {
      valid: false,
      issues: [
        {
          path: "timezone",
          code: "invalid_value",
          message: "unknown zone",
        },
      ],
      resolved: undefined,
    };
    await expect(harness.service.create(draftFor())).rejects.toMatchObject({
      code: "invalid_configuration",
      issues: [
        {
          path: "timezone",
          code: "invalid_value",
          message: "unknown zone",
        },
      ],
    });
    expect(harness.store.records).toEqual([]);
  });

  it("allows creating when Chrome is missing but reports a warning", async () => {
    const harness = setup();
    harness.adapter.validation = {
      valid: false,
      issues: [
        {
          path: "browser.executablePath",
          code: "chrome_not_found",
          message: "Chrome not found",
        },
      ],
      resolved: undefined,
    };
    harness.adapter.discovered = [];
    const view = await harness.service.create(draftFor());
    expect(view.warnings).toContain(
      "未在标准位置找到 Chrome；可以手动指定 Chrome 可执行文件。",
    );
  });

  it("allows a manually configured missing Chrome with a distinct warning", async () => {
    const harness = setup();
    harness.adapter.discovered = [];
    const view = await harness.service.create(
      draftFor({ browser: { executablePath: "C:\\Missing\\chrome.exe" } }),
    );
    expect(view.warnings).toContain(
      "指定的 Chrome 可执行文件不可用，请重新选择。",
    );
  });

  it("retries id allocation and rejects exhausted or malformed ids", async () => {
    const harness = setup({ ids: ["env-test", "env-fresh"] });
    seed(harness);
    expect((await harness.service.create(draftFor())).id).toBe("env-fresh");

    const invalid = setup({ ids: ["NOT-VALID"] });
    await expect(invalid.service.create(draftFor())).rejects.toMatchObject({
      code: "internal_error",
    });

    const exhausted = setup({ ids: [] });
    await expect(exhausted.service.create(draftFor())).rejects.toThrow(
      "no more ids",
    );
  });

  it("wraps adapter validation failures", async () => {
    const harness = setup();
    harness.adapter.validateEnvironment = () => {
      throw new Error("adapter exploded");
    };
    await expect(harness.service.create(draftFor())).rejects.toMatchObject({
      code: "invalid_configuration",
      message: "环境配置无法校验。",
    });
  });
});

describe("DesktopEnvironmentService update", () => {
  it("saves changes for a stopped environment", async () => {
    const harness = setup();
    seed(harness);
    const result = await harness.service.update(
      "env-test",
      draftFor({ name: "新的名字", timezone: "Europe/Berlin" }),
    );
    expect(result).toMatchObject({
      appliedFields: [],
      restartFields: [],
      message: "环境未运行，配置已保存，将在下次启动时生效。",
    });
    expect(result.environment.name).toBe("新的名字");
    expect(harness.store.records[0]).toMatchObject({
      name: "新的名字",
      pendingRestart: false,
    });
  });

  it("reports an unchanged configuration", async () => {
    const harness = setup();
    seed(harness);
    const result = await harness.service.update("env-test", draftFor());
    expect(result.message).toBe("配置没有变化。");
    expect(harness.store.updateCalls).toBe(0);
  });

  it("saves with an unknown-state message when the runtime is unavailable", async () => {
    const harness = setup();
    seed(harness);
    harness.adapter.statusError = new BrowserAdapterError(
      "runtime_unavailable",
      "pipe unavailable",
    );
    const result = await harness.service.update(
      "env-test",
      draftFor({ name: "saved" }),
    );
    expect(result.message).toContain("运行时状态未知");
    expect(result.environment.state).toBe("unknown");
    expect(result.environment.warnings[0]).toContain("运行时状态不可用");
  });

  it.each(["starting", "stopping"] as const)(
    "refuses edits while %s",
    async (state) => {
      const harness = setup();
      seed(harness);
      harness.adapter.statuses.set(
        "env-test",
        runningStatus("env-test", { state }),
      );
      await expect(
        harness.service.update("env-test", draftFor({ name: "blocked" })),
      ).rejects.toMatchObject({ code: "environment_busy" });
    },
  );

  it("applies hot fields to a running browser and verifies them", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);
    harness.adapter.report = reportFor("env-test", {
      timezone: "Europe/Berlin",
    });

    const result = await harness.service.update(
      "env-test",
      draftFor({ timezone: "Europe/Berlin" }),
    );

    expect(result.appliedFields).toEqual(["timezone"]);
    expect(result.restartFields).toEqual([]);
    expect(result.environment.pendingRestart).toBe(false);
    expect(result.environment.verification?.stale).toBe(false);
    expect(result.message).toContain("已立即应用：timezone");
    expect(harness.adapter.applyCalls).toHaveLength(1);
    expect(configOf(harness.adapter.applyCalls[0]?.config).timezone).toBe(
      "Europe/Berlin",
    );
    expect(harness.adapter.verifyCalls[0]?.timeoutMs).toBe(3_000);
  });

  it("rolls back and reports when a hot field fails verification", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);
    harness.adapter.report = reportFor("env-test", { status: "failed" });

    await expect(
      harness.service.update(
        "env-test",
        draftFor({ timezone: "Europe/Berlin" }),
      ),
    ).rejects.toMatchObject({
      code: "config_verification_failed",
      issues: [
        {
          path: "config.timezone",
          code: "failed",
        },
      ],
    });
    expect(harness.adapter.applyCalls).toHaveLength(2);
    expect(configOf(harness.adapter.applyCalls[1]?.config).timezone).toBe(
      "Asia/Shanghai",
    );
    expect(harness.store.records[0]?.timezone).toBe("Asia/Shanghai");
  });

  it("does not save when applying a hot field fails", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);
    harness.adapter.applyError = new Error("CDP closed");

    await expect(
      harness.service.update(
        "env-test",
        draftFor({ timezone: "Europe/Berlin" }),
      ),
    ).rejects.toMatchObject({ code: "config_apply_failed" });
    expect(harness.store.records[0]?.timezone).toBe("Asia/Shanghai");
  });

  it("marks restart-required fields without applying them", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);

    const result = await harness.service.update(
      "env-test",
      draftFor({
        browser: { executablePath: "C:\\Chrome\\other\\chrome.exe" },
      }),
    );

    expect(result.appliedFields).toEqual([]);
    expect(result.restartFields).toEqual(["browser.executablePath"]);
    expect(result.environment.pendingRestart).toBe(true);
    expect(result.environment.warnings).toContain(
      "有配置修改需要重启环境后生效。",
    );
    expect(result.message).toContain("需重启后生效：browser.executablePath");
    expect(harness.adapter.applyCalls).toHaveLength(0);
  });

  it("updates the name alone without requiring a restart", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);

    const result = await harness.service.update(
      "env-test",
      draftFor({ name: "重命名" }),
    );
    expect(result.restartFields).toEqual([]);
    expect(result.environment.pendingRestart).toBe(false);
    expect(result.message).toBe("名称已更新");
  });

  it("applies hot fields while marking restart fields", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);
    harness.adapter.report = reportFor("env-test", {
      timezone: "Europe/Berlin",
    });

    const result = await harness.service.update(
      "env-test",
      draftFor({
        name: "混合",
        timezone: "Europe/Berlin",
        browser: { executablePath: "C:\\Chrome\\other\\chrome.exe" },
      }),
    );
    expect(result.appliedFields).toEqual(["timezone"]);
    expect(result.restartFields).toEqual(["browser.executablePath"]);
    expect(result.environment.pendingRestart).toBe(true);
    expect(result.message).toContain("名称已更新");
    expect(result.environment.verification?.stale).toBe(false);
  });

  it("marks a cached verification stale when only restart fields change", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);
    await harness.service.verify("env-test");
    const before = await harness.service.get("env-test");
    expect(before.verification?.stale).toBe(false);

    const result = await harness.service.update(
      "env-test",
      draftFor({
        browser: { executablePath: "C:\\Chrome\\other\\chrome.exe" },
      }),
    );
    expect(result.environment.verification?.stale).toBe(true);
  });

  it("refuses configuration changes when the running browser still uses an older config", async () => {
    const harness = setup();
    seed(harness, recordFor({ pendingRestart: true }));
    withStatus(harness);

    await expect(
      harness.service.update(
        "env-test",
        draftFor({ timezone: "Europe/Berlin" }),
      ),
    ).rejects.toMatchObject({
      code: "environment_restart_required",
    });
  });

  it("refuses a persisted record with a relocated data directory", async () => {
    const harness = setup();
    seed(harness, {
      ...recordFor(),
      dataDir: "C:\\other\\chrome-data",
    });
    await expect(
      harness.service.update("env-test", draftFor({ name: "x" })),
    ).rejects.toMatchObject({ code: "data_directory_conflict" });
  });

  it("validates ids and existence", async () => {
    const harness = setup();
    await expect(
      harness.service.update("BAD", draftFor()),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      harness.service.update("env-missing", draftFor()),
    ).rejects.toMatchObject({ code: "environment_not_found" });
  });
});

describe("DesktopEnvironmentService launch", () => {
  it.each(["restricted", "app_container"] as const)(
    "refuses to launch a stored environment with %s isolation",
    async (isolation) => {
      const harness = setup();
      seed(harness, recordFor({ isolation }));
      await expect(harness.service.launch("env-test")).rejects.toMatchObject({
        code: "unsupported_isolation",
      });
      expect(harness.adapter.launchCalls).toBe(0);
    },
  );

  it("launches through the adapter and records verified configuration", async () => {
    const harness = setup();
    seed(harness);
    const view = await harness.service.launch("env-test");

    expect(harness.adapter.launchCalls).toBe(1);
    expect(view).toMatchObject({
      state: "running",
      pid: 4_242,
      processInstanceId: "proc-env-test",
      browserVersion: "156.0.0.0",
      cdp: {
        connected: true,
        endpointOrigin: "ws://127.0.0.1:9222",
      },
    });
    expect(view.verification?.fields).toHaveLength(3);
    expect(view.verification?.stale).toBe(false);
    expect(view.lastLaunch?.ok).toBe(true);
    expect(view.lastLaunch?.message).toContain("配置验证：3 项已验证");
    expect(harness.store.records[0]?.lastLaunch?.ok).toBe(true);
    expect(harness.log.list("env-test").map((entry) => entry.code)).toContain(
      "environment_started",
    );
  });

  it("keeps a successful launch when verification is unavailable", async () => {
    const harness = setup();
    seed(harness);
    harness.adapter.verifyError = new Error("CDP timeout");
    const view = await harness.service.launch("env-test");

    expect(view.state).toBe("running");
    expect(view.verification?.fields).toHaveLength(3);
    expect(harness.log.list("env-test").map((entry) => entry.code)).toContain(
      "verification_unavailable",
    );
  });

  it("records a structured failure and allows a retry", async () => {
    const harness = setup();
    seed(harness);
    harness.adapter.launchError = new BrowserAdapterError(
      "launch_failed",
      "Chrome exited early",
      { environmentId: "env-test" },
    );

    await expect(harness.service.launch("env-test")).rejects.toMatchObject({
      code: "launch_failed",
      message: "Chrome exited early",
    });
    const view = await harness.service.get("env-test");
    expect(view.state).toBe("stopped");
    expect(view.lastLaunch).toMatchObject({
      ok: false,
      code: "launch_failed",
    });
    expect(view.lastLaunch?.message).toContain("启动失败");
    expect(harness.log.list("env-test")[0]?.level).toBe("error");

    harness.adapter.launchError = undefined;
    const retried = await harness.service.launch("env-test");
    expect(retried.state).toBe("running");
    expect(retried.lastLaunch?.ok).toBe(true);
  });

  it("refuses to launch an invalid stored configuration", async () => {
    const harness = setup();
    seed(harness);
    harness.adapter.validation = {
      valid: false,
      issues: [
        { path: "locale", code: "invalid_value", message: "bad locale" },
      ],
      resolved: undefined,
    };
    await expect(harness.service.launch("env-test")).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    expect(harness.adapter.launchCalls).toBe(0);
    expect((await harness.service.get("env-test")).lastLaunch?.ok).toBe(false);
  });

  it("rejects a second launch while one is in flight", async () => {
    const harness = setup();
    seed(harness);
    const pending = deferredLaunch();
    harness.adapter.pendingLaunch = pending.promise;

    const first = harness.service.launch("env-test");
    await vi.waitFor(() => {
      expect(harness.adapter.launchCalls).toBe(1);
    });
    await expect(harness.service.launch("env-test")).rejects.toMatchObject({
      code: "environment_busy",
    });
    harness.adapter.statuses.set("env-test", runningStatus("env-test"));
    pending.resolve({
      status: runningStatus("env-test"),
      config: reportFor("env-test"),
    });
    await expect(first).resolves.toMatchObject({ state: "running" });
  });

  it("refuses a persisted record with an unexpected data directory", async () => {
    const harness = setup();
    seed(harness, {
      ...recordFor(),
      dataDir: "C:\\outside\\chrome-data",
    });
    await expect(harness.service.launch("env-test")).rejects.toMatchObject({
      code: "data_directory_conflict",
    });
  });

  it("reports an invalid id before touching the adapter", async () => {
    const harness = setup();
    await expect(harness.service.launch("BAD")).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(harness.adapter.launchCalls).toBe(0);
  });
});

describe("DesktopEnvironmentService stop", () => {
  it("stops gracefully and clears a pending restart", async () => {
    const harness = setup();
    seed(harness, recordFor({ pendingRestart: true }));
    withStatus(harness);
    const view = await harness.service.stop("env-test", { force: false });

    expect(harness.adapter.stopCalls).toEqual([
      { id: "env-test", options: { mode: "graceful" } },
    ]);
    expect(view.state).toBe("stopped");
    expect(view.pendingRestart).toBe(false);
    expect(harness.store.records[0]?.pendingRestart).toBe(false);
    expect(harness.log.list()[0]?.code).toBe("environment_stopped");
  });

  it("forces a stop when requested", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);
    await harness.service.stop("env-test", { force: true });
    expect(harness.adapter.stopCalls[0]?.options).toEqual({ mode: "force" });
  });

  it("keeps persisted metadata when stopping fails", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);
    harness.adapter.stopError = new Error("runtime refused");

    await expect(
      harness.service.stop("env-test", { force: true }),
    ).rejects.toMatchObject({
      code: "internal_error",
      message: "停止环境失败。",
    });
    expect(harness.store.records[0]?.pendingRestart).toBe(false);
    expect(harness.log.list()[0]?.code).toBe("environment_stop_failed");
  });

  it("rejects concurrent stop requests", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);
    let resolveStop: (status: ReturnType<typeof stoppedStatus>) => void = () =>
      undefined;
    harness.adapter.stopEnvironment = (id, options) => {
      harness.adapter.stopCalls.push({ id, options });
      return new Promise((resolve) => {
        resolveStop = (status) => {
          harness.adapter.statuses.set(id, status);
          resolve(status);
        };
      });
    };

    const first = harness.service.stop("env-test", { force: false });
    await vi.waitFor(() => {
      expect(harness.adapter.stopCalls).toHaveLength(1);
    });
    await expect(
      harness.service.stop("env-test", { force: true }),
    ).rejects.toMatchObject({ code: "environment_busy" });
    resolveStop(stoppedStatus("env-test"));
    await expect(first).resolves.toMatchObject({ state: "stopped" });
  });

  it("marks a cached verification stale after stopping", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);
    await harness.service.launch("env-test");
    const stopped = await harness.service.stop("env-test", { force: false });
    expect(stopped.verification?.stale).toBe(true);
  });
});

describe("DesktopEnvironmentService verify", () => {
  it("verifies a running environment", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);
    const view = await harness.service.verify("env-test");
    expect(view.verification?.fields.map((field) => field.status)).toEqual([
      "verified",
      "verified",
      "verified",
    ]);
    expect(harness.adapter.connectCalls).toBe(0);
    expect(harness.log.list()[0]?.code).toBe("configuration_verified");
  });

  it("reconnects CDP before verifying", async () => {
    const harness = setup();
    seed(harness);
    harness.adapter.statuses.set(
      "env-test",
      runningStatus("env-test", {
        cdp: {
          connected: false,
          endpoint: undefined,
          connectedAtUnixMs: undefined,
        },
      }),
    );
    await harness.service.verify("env-test");
    expect(harness.adapter.connectCalls).toBe(1);
    expect(harness.adapter.verifyCalls).toHaveLength(1);
  });

  it("refuses to verify a stopped environment", async () => {
    const harness = setup();
    seed(harness);
    await expect(harness.service.verify("env-test")).rejects.toMatchObject({
      code: "environment_not_running",
    });
  });

  it("maps adapter verification failures", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);
    harness.adapter.verifyError = new BrowserAdapterError(
      "cdp_timeout",
      "no answer",
    );
    await expect(harness.service.verify("env-test")).rejects.toMatchObject({
      code: "cdp_timeout",
    });
  });

  it("maps reconnect failures", async () => {
    const harness = setup();
    seed(harness);
    harness.adapter.statuses.set(
      "env-test",
      runningStatus("env-test", {
        cdp: {
          connected: false,
          endpoint: undefined,
          connectedAtUnixMs: undefined,
        },
      }),
    );
    harness.adapter.connectError = new BrowserAdapterError(
      "cdp_disconnected",
      "cannot reconnect",
    );
    await expect(harness.service.verify("env-test")).rejects.toMatchObject({
      code: "cdp_disconnected",
    });
  });

  it("requires a restart before verifying when the live config is stale", async () => {
    const harness = setup();
    seed(harness, recordFor({ pendingRestart: true }));
    withStatus(harness);
    await expect(harness.service.verify("env-test")).rejects.toMatchObject({
      code: "environment_restart_required",
    });
  });
});

describe("DesktopEnvironmentService remove", () => {
  it("removes metadata while keeping browser data by default", async () => {
    const harness = setup();
    seed(harness);
    await harness.service.remove("env-test", { deleteData: false });
    expect(harness.store.records).toEqual([]);
    expect(harness.cleanup.assertCalls).toEqual([]);
    expect(harness.cleanup.removeCalls).toEqual([]);
    expect(harness.log.list()[0]?.code).toBe("environment_removed");
  });

  it("cleans only after confirming the environment is stopped", async () => {
    const harness = setup();
    seed(harness);
    harness.adapter.statuses.set(
      "env-test",
      stoppedStatus("env-test", {
        userDataDir: expectedProfileDir(harness.dataRoot, "env-test"),
      }),
    );
    await harness.service.remove("env-test", { deleteData: true });
    expect(harness.cleanup.assertCalls[0]?.dir).toBe(
      expectedProfileDir(harness.dataRoot, "env-test"),
    );
    expect(harness.cleanup.removeCalls).toHaveLength(1);
  });

  it.each(["running", "starting", "stopping"] as const)(
    "refuses to remove a %s environment",
    async (state) => {
      const harness = setup();
      seed(harness);
      harness.adapter.statuses.set(
        "env-test",
        runningStatus("env-test", { state }),
      );
      await expect(
        harness.service.remove("env-test", { deleteData: false }),
      ).rejects.toMatchObject({ code: "environment_running" });
    },
  );

  it("refuses data cleanup while the state is unknown", async () => {
    const harness = setup();
    seed(harness);
    harness.adapter.statusError = new BrowserAdapterError(
      "runtime_unavailable",
      "pipe down",
    );
    await expect(
      harness.service.remove("env-test", { deleteData: true }),
    ).rejects.toMatchObject({ code: "data_cleanup_refused" });
    expect(harness.cleanup.assertCalls).toEqual([]);
  });

  it("propagates safe-path refusals without deleting metadata", async () => {
    const harness = setup();
    seed(harness);
    harness.cleanup.assertError = new DesktopError(
      "data_cleanup_refused",
      "unsafe",
    );
    await expect(
      harness.service.remove("env-test", { deleteData: true }),
    ).rejects.toMatchObject({ code: "data_cleanup_refused" });
    expect(harness.store.records).toHaveLength(1);
  });

  it("reports partial deletion when cleanup fails after metadata removal", async () => {
    const harness = setup();
    seed(harness);
    harness.cleanup.removeError = new Error("locked file");
    await expect(
      harness.service.remove("env-test", { deleteData: true }),
    ).rejects.toMatchObject({
      code: "data_cleanup_failed",
      message: "环境记录已删除，但浏览器数据目录未能清理，请查看诊断信息。",
    });
    expect(harness.store.records).toEqual([]);
  });

  it("refuses a relocated data directory", async () => {
    const harness = setup();
    seed(harness, {
      ...recordFor(),
      dataDir: "C:\\outside\\chrome-data",
    });
    await expect(
      harness.service.remove("env-test", { deleteData: false }),
    ).rejects.toMatchObject({ code: "data_directory_conflict" });
  });

  it("validates the id", async () => {
    const harness = setup();
    await expect(
      harness.service.remove("BAD", { deleteData: false }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("DesktopEnvironmentService views and discovery", () => {
  it("reports runtime, persistence, Chrome and restart warnings", async () => {
    const harness = setup();
    const record = {
      ...recordFor({ pendingRestart: true }),
      dataDir: "C:\\relocated\\chrome-data",
    };
    seed(harness, record);
    harness.store.setWarning({
      code: "persistence_recovered",
      message: "registry recovered",
      backupPath: undefined,
    });
    harness.adapter.discovered = [];
    harness.adapter.statuses.set(
      "env-test",
      stoppedStatus("env-test", {
        lastError: { code: "cdp_disconnected", message: "CDP closed" },
      }),
    );

    const [view] = await harness.service.list();
    expect(view?.warnings).toEqual(
      expect.arrayContaining([
        "记录中的数据目录与当前数据根不一致；启动、验证或清理数据会被拒绝。",
        "有配置修改需要重启环境后生效。",
        "registry recovered",
        "最近错误：CDP closed",
        "未在标准位置找到 Chrome；可以手动指定 Chrome 可执行文件。",
      ]),
    );
  });

  it("reports lookup failures as unknown state", async () => {
    const harness = setup();
    seed(harness);
    harness.adapter.statusError = new BrowserAdapterError(
      "runtime_unavailable",
      "pipe down",
    );
    const view = await harness.service.get("env-test");
    expect(view.state).toBe("unknown");
    expect(view.lastError).toEqual({
      code: "runtime_unavailable",
      message: "pipe down",
    });
    expect(view.warnings).toContain("运行时状态不可用：pipe down");
    expect(view.cdp).toEqual({ connected: false });
  });

  it("maps unexpected status failures to runtime_operation_failed", async () => {
    const harness = setup();
    seed(harness);
    harness.adapter.statusError = new Error("unexpected");
    const view = await harness.service.get("env-test");
    expect(view.lastError).toEqual({
      code: "runtime_operation_failed",
      message: "unexpected",
    });
  });

  it("omits runtime handles when the adapter has none", async () => {
    const harness = setup();
    seed(harness);
    harness.adapter.statuses.set(
      "env-test",
      stoppedStatus("env-test", {
        cdp: {
          connected: false,
          endpoint: "not a url",
          connectedAtUnixMs: undefined,
        },
      }),
    );
    const view = await harness.service.get("env-test");
    expect(view.pid).toBeUndefined();
    expect(view.processInstanceId).toBeUndefined();
    expect(view.startedAtUnixMs).toBeUndefined();
    expect(view.cdp).toEqual({ connected: false });
    expect(view.browserVersion).toBe("156.0.0.0");
  });

  it("keeps a successful verification when the environment later stops", async () => {
    const harness = setup();
    seed(harness);
    withStatus(harness);
    await harness.service.launch("env-test");
    harness.adapter.statuses.set("env-test", stoppedStatus("env-test"));
    const view = await harness.service.get("env-test");
    expect(view.verification?.stale).toBe(true);
  });

  it("discovers browsers through the adapter", () => {
    const harness = setup();
    expect(harness.service.discoverBrowsers()).toEqual([
      {
        executablePath: "C:\\Chrome\\chrome.exe",
        version: "156.0.0.0",
        source: "system",
      },
    ]);
    harness.adapter.discoverError = new Error("registry failed");
    try {
      harness.service.discoverBrowsers();
      expect.fail("discovery should throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "chrome_not_found" });
    }
  });

  it("initialises and logs the persisted environment count", async () => {
    const harness = setup();
    seed(harness);
    harness.store.setWarning({
      code: "persistence_recovered",
      message: "recovered",
      backupPath: "C:\\backup",
    });
    await harness.service.initialize();
    expect(harness.log.list().map((entry) => entry.code)).toEqual([
      "persistence_recovered",
      "desktop_ready",
    ]);
    expect(harness.service.warning()).toMatchObject({
      code: "persistence_recovered",
    });
  });

  it("exposes per-environment logs", () => {
    const harness = setup();
    seed(harness);
    harness.log.info("global", "all");
    harness.log.warn("specific", "env", "env-test");
    expect(
      harness.service.logsFor("env-test").map((entry) => entry.code),
    ).toEqual(["global", "specific"]);
  });

  it("maps a missing record to a typed error", async () => {
    const harness = setup();
    await expect(harness.service.get("env-missing")).rejects.toMatchObject({
      code: "environment_not_found",
    });
  });
});

describe("configuration projection", () => {
  it("maps a record to the adapter contract without adding defaults", () => {
    const record = recordFor();
    expect(toAdapterConfig(record)).toEqual({
      id: "env-test",
      name: "测试环境",
      browser: { userDataDir: record.dataDir },
      runtimePolicy: { isolation: "managed" },
      persistence: { mode: "persistent" },
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      viewport: { width: 1440, height: 900 },
    });
  });

  it("includes every optional adapter field", () => {
    const record = {
      ...recordFor({ executablePath: "C:\\Chrome\\chrome.exe" }),
      geolocation: { latitude: 31.2, longitude: 121.5, accuracy: 20 },
      runtimePolicy: {
        isolation: "restricted" as const,
        maxProcesses: 8,
        memoryLimitBytes: 1024,
      },
      launch: { additionalArguments: ["--headless=new"] },
      viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
    };
    expect(toAdapterConfig(record)).toMatchObject({
      browser: {
        executablePath: "C:\\Chrome\\chrome.exe",
        userDataDir: record.dataDir,
      },
      runtimePolicy: {
        isolation: "restricted",
        maxProcesses: 8,
        memoryLimitBytes: 1024,
      },
      viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
      geolocation: { latitude: 31.2, longitude: 121.5, accuracy: 20 },
      launch: { additionalArguments: ["--headless=new"] },
    });
  });

  it("detects every changed field group", () => {
    const base = recordFor();
    const changed = {
      ...base,
      name: "x",
      browser: { executablePath: "C:\\Chrome\\chrome.exe" },
      timezone: "Europe/Berlin",
      locale: "en-US",
      viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
      geolocation: { latitude: 1, longitude: 2, accuracy: 3 },
      runtimePolicy: {
        isolation: "restricted" as const,
        maxProcesses: 9,
        memoryLimitBytes: 2048,
      },
      launch: { additionalArguments: ["--headless=new"] },
    };
    expect(changedFields(base, changed)).toEqual([
      "name",
      "browser.executablePath",
      "timezone",
      "locale",
      "viewport.width",
      "viewport.height",
      "viewport.deviceScaleFactor",
      "geolocation.latitude",
      "geolocation.longitude",
      "geolocation.accuracy",
      "runtimePolicy.isolation",
      "runtimePolicy.maxProcesses",
      "runtimePolicy.memoryLimitBytes",
      "launch.additionalArguments",
    ]);
  });

  it("compares argument lists by value", () => {
    const left = {
      ...recordFor(),
      launch: { additionalArguments: ["--a", "--b"] },
    };
    expect(
      changedFields(left, {
        ...left,
        launch: { additionalArguments: ["--a", "--b"] },
      }),
    ).toEqual([]);
    expect(
      changedFields(left, {
        ...left,
        launch: { additionalArguments: ["--b", "--a"] },
      }),
    ).toEqual(["launch.additionalArguments"]);
    expect(changedFields(left, { ...left, launch: {} })).toEqual([
      "launch.additionalArguments",
    ]);
  });
});
