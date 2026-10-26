import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RuntimeClient,
  RuntimeHost,
  isRuntimeClientError,
  type RuntimeClientErrorCode,
} from "@virealm/runtime-client";
import type {
  Capability,
  CapabilityReport,
  CapabilityState,
} from "@virealm/contracts";

import type {
  IsolationCapabilityView,
  RuntimeStatusView,
} from "../../shared/contracts.js";
import type { DesktopLog } from "../logging.js";

export interface RuntimeControllerOptions {
  /** `apps/desktop` in development, `resources/app.asar` when packaged. */
  readonly appRoot: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly log: DesktopLog;
  readonly executablePath?: string | undefined;
  readonly pipePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly probeTimeoutMs?: number;
}

/**
 * Owns the local `virealm-runtime` daemon.
 *
 * The desktop is allowed to start the runtime process itself; it never starts
 * Chrome. BrowserAdapter receives this controller's client and asks the
 * runtime to launch every browser.
 */
export class RuntimeController {
  readonly pipePath: string;
  readonly client: RuntimeClient;
  private readonly executablePath: string | undefined;
  /** True when the endpoint name was generated here and is ours to remove. */
  private readonly ownsEndpoint: boolean;
  private readonly log: DesktopLog;
  private readonly now: () => number;
  private readonly probeTimeoutMs: number;
  private host: RuntimeHost | undefined;
  private startAttempt: Promise<RuntimeStatusView> | undefined;
  private checkedAtUnixMs: number | undefined;
  private lastReport: CapabilityReport | undefined;
  private lastError: { code: string; message: string } | undefined;
  private stopped = false;

  constructor(options: RuntimeControllerOptions) {
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 2_500;
    this.pipePath = options.pipePath ?? defaultEndpoint();
    this.ownsEndpoint = options.pipePath === undefined;
    this.executablePath =
      options.executablePath ?? resolveRuntimeExecutable(options);
    this.client = new RuntimeClient({ pipePath: this.pipePath });
  }

  get runtimeExecutable(): string | undefined {
    return this.executablePath;
  }

  /** Start the daemon once; failures are recorded and surfaced, never fatal. */
  async initialize(): Promise<RuntimeStatusView> {
    return this.ensureStarted();
  }

  /**
   * Make sure the daemon is running. A dead daemon is restarted on the same
   * pipe; a healthy one is only re-probed.
   */
  async ensureStarted(): Promise<RuntimeStatusView> {
    if (this.stopped) {
      return this.view();
    }
    if (this.startAttempt !== undefined) {
      return this.startAttempt;
    }
    const attempt = this.startAndProbe();
    this.startAttempt = attempt;
    try {
      return await attempt;
    } finally {
      if (this.startAttempt === attempt) {
        this.startAttempt = undefined;
      }
    }
  }

  /** Re-probe; restart the daemon when it is no longer serving. */
  async retry(): Promise<RuntimeStatusView> {
    if (this.stopped) {
      return this.view();
    }
    const current = await this.probe();
    if (current.available) {
      return current;
    }
    await this.stopHost();
    return this.ensureStarted();
  }

  async status(): Promise<RuntimeStatusView> {
    return this.probe();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.stopHost();
    this.client.close();
    // The runtime never unlinks its own socket: that would race a replacement
    // instance binding the same name. This controller's endpoint is unique to
    // it, so removing it after the daemon has stopped leaves nothing behind.
    if (this.ownsEndpoint && !this.pipePath.startsWith("\\\\.\\pipe\\")) {
      await Promise.all(
        [this.pipePath, `${this.pipePath}.lock`].map((file) =>
          rm(file, { force: true }).catch(() => undefined),
        ),
      );
    }
  }

  private async startAndProbe(): Promise<RuntimeStatusView> {
    if (this.executablePath === undefined) {
      this.lastError = {
        code: "runtime_not_started",
        message:
          "未找到 virealm-runtime。请先构建 Rust 运行时，或设置 VIREALM_RUNTIME_PATH。",
      };
      this.checkedAtUnixMs = this.now();
      this.log.warn("runtime_missing", this.lastError.message);
      return this.view();
    }
    if (!existsSync(this.executablePath)) {
      this.lastError = {
        code: "runtime_not_started",
        message: `运行时文件不存在：${this.executablePath}`,
      };
      this.checkedAtUnixMs = this.now();
      this.log.warn("runtime_missing", this.lastError.message);
      return this.view();
    }

    if (this.host === undefined) {
      try {
        this.host = await RuntimeHost.start({
          executablePath: this.executablePath,
          pipePath: this.pipePath,
          startupTimeoutMs: 10_000,
        });
        this.log.info("runtime_started", "已启动本地进程运行时。");
      } catch (error) {
        this.lastError = {
          code: "runtime_not_started",
          message: "本地运行时启动失败。请确认运行时文件完整，然后重新检测。",
        };
        this.checkedAtUnixMs = this.now();
        this.log.error(
          "runtime_start_failed",
          `本地运行时启动失败：${errorMessage(error)}`,
        );
        return this.view();
      }
    }
    return this.probe();
  }

  private async probe(): Promise<RuntimeStatusView> {
    if (this.stopped) {
      return this.view();
    }
    if (this.executablePath === undefined) {
      return this.view();
    }
    if (!existsSync(this.executablePath)) {
      this.lastReport = undefined;
      this.lastError = {
        code: "runtime_not_started",
        message: `运行时文件不存在：${this.executablePath}`,
      };
      this.checkedAtUnixMs = this.now();
      return this.view();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.probeTimeoutMs);
    try {
      const report = await this.client.getCapabilities(controller.signal);
      this.lastReport = report;
      this.lastError = undefined;
      this.checkedAtUnixMs = this.now();
    } catch (error) {
      const code = isRuntimeClientError(error)
        ? error.code
        : "runtime_unavailable";
      this.lastError = {
        code,
        message: runtimeFailureMessage(code, error, this.pipePath),
      };
      this.checkedAtUnixMs = this.now();
      this.log.warn(
        "runtime_probe_failed",
        `运行时连接失败：${errorMessage(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    return this.view();
  }

  private view(): RuntimeStatusView {
    const report = this.lastReport;
    return {
      available: report !== undefined && this.lastError === undefined,
      pipePath: this.pipePath,
      executablePath: this.executablePath,
      error: this.lastError,
      platform:
        report === undefined
          ? undefined
          : {
              os: report.platform.os,
              architecture: report.platform.architecture,
              elevated: report.platform.elevated,
              ...(report.platform.osVersion === undefined
                ? {}
                : { osVersion: report.platform.osVersion }),
            },
      isolation: report === undefined ? [] : isolationViews(report),
      checkedAtUnixMs: this.checkedAtUnixMs,
    };
  }

  private async stopHost(): Promise<void> {
    const host = this.host;
    this.host = undefined;
    if (host === undefined) {
      return;
    }
    try {
      await host.stop();
    } catch (error) {
      this.log.warn(
        "runtime_stop_failed",
        `停止运行时失败：${errorMessage(error)}`,
      );
    }
  }
}

export function resolveRuntimeExecutable(
  options: Pick<
    RuntimeControllerOptions,
    "appRoot" | "isPackaged" | "resourcesPath" | "environment"
  >,
): string | undefined {
  const environment = options.environment ?? process.env;
  const override = environment.VIREALM_RUNTIME_PATH;
  if (override !== undefined && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  const fileName =
    process.platform === "win32" ? "virealm-runtime.exe" : "virealm-runtime";
  const candidates = options.isPackaged
    ? [path.join(options.resourcesPath, "runtime", fileName)]
    : [
        path.resolve(
          options.appRoot,
          "..",
          "..",
          "target",
          "release",
          fileName,
        ),
        path.resolve(options.appRoot, "..", "..", "target", "debug", fileName),
      ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * Longest Unix socket path, in bytes, that the runtime accepts. A desktop
 * endpoint under `$TMPDIR` normally fits; a long temporary directory falls
 * back to `/tmp` rather than failing at connect time.
 */
const MAX_ENDPOINT_BYTES = 100;

export function defaultEndpoint(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return String.raw`\\.\pipe\virealm-desktop-${process.pid}-${randomUUID().slice(0, 8)}`;
  }
  const name = `virealm-desktop-${String(process.pid)}-${randomUUID().slice(0, 8)}.sock`;
  const primary = path.join(tmpdir(), name);
  return Buffer.byteLength(primary) <= MAX_ENDPOINT_BYTES
    ? primary
    : path.join("/tmp", name);
}

export function isolationViews(
  report: CapabilityReport,
): IsolationCapabilityView[] {
  if (report.platform.os === "macos") {
    return [
      combine(
        "managed",
        "进程组管理",
        [report.processGroup ?? { state: "not_verified" }],
        "把 Chrome 及其受管子进程放进同一 POSIX 进程组；停止或退出时向整组发送终止信号。",
      ),
      forceUnsupported(
        "restricted",
        "受限令牌",
        "macOS 不支持：受限令牌是 Windows 专属能力，运行时不会模拟或降级。",
      ),
      forceUnsupported(
        "app_container",
        "AppContainer",
        "macOS 不支持：AppContainer 是 Windows 专属能力，运行时不会模拟或降级。",
      ),
    ];
  }

  return [
    combine("managed", "Job Object 进程包含", [report.jobObject]),
    combine("restricted", "受限令牌", [report.restrictedToken]),
    combine("app_container", "AppContainer 隔离", [
      report.appContainer,
      report.appContainerAcl,
    ]),
  ];
}

function forceUnsupported(
  mode: IsolationCapabilityView["mode"],
  label: string,
  detail: string,
): IsolationCapabilityView {
  return { mode, state: "unsupported", detail: `${label}：${detail}` };
}

function combine(
  mode: IsolationCapabilityView["mode"],
  label: string,
  capabilities: readonly Capability[],
  supportedDetail?: string,
): IsolationCapabilityView {
  const states = capabilities.map((capability) => capability.state);
  const state = aggregateState(states);
  const details = capabilities
    .map((capability) => capability.detail)
    .filter((detail): detail is string => detail !== undefined);
  const positive =
    state === "supported" && supportedDetail !== undefined
      ? supportedDetail
      : undefined;
  return {
    mode,
    state,
    detail:
      details.length > 0
        ? `${label}：${details.join(" ")}`
        : `${label}：${positive ?? stateLabel(state)}`,
  };
}

function aggregateState(
  states: readonly CapabilityState[],
): IsolationCapabilityView["state"] {
  if (states.every((state) => state === "supported")) {
    return "supported";
  }
  if (states.some((state) => state === "unsupported")) {
    return "unsupported";
  }
  if (states.some((state) => state === "unavailable")) {
    return "unavailable";
  }
  return "not_verified";
}

function stateLabel(state: CapabilityState): string {
  switch (state) {
    case "supported":
      return "可用";
    case "unsupported":
      return "当前系统不支持";
    case "unavailable":
      return "当前会话不可用";
    case "not_verified":
      return "尚未验证";
  }
}

function runtimeFailureMessage(
  code: RuntimeClientErrorCode,
  error: unknown,
  pipePath: string,
): string {
  switch (code) {
    case "runtime_unavailable":
      return `无法连接到本地运行时（${endpointKind(pipePath)} ${pipePath}）。请确认运行时已启动，或在“运行时”页面重新检测。`;
    case "connection_timeout":
    case "request_timeout":
      return "本地运行时响应超时。请稍后重新检测。";
    case "connection_closed":
      return "与本地运行时的连接已断开。重新检测会尝试恢复连接。";
    case "protocol_violation":
      return "本地运行时返回了无法识别的响应，可能版本不匹配。";
    case "host_start_failed":
      return "本地运行时启动失败。请检查运行时文件是否完整。";
    case "runtime_error":
      return error instanceof Error ? error.message : "本地运行时报告了错误。";
    case "invalid_request":
      return "发送给本地运行时的请求无效。";
    case "request_aborted":
      return "运行时请求已取消。";
    case "client_closed":
      return "运行时连接已关闭，请重新检测。";
  }
}

/** Named pipe on Windows, Unix domain socket elsewhere. */
export function endpointKind(endpoint: string): string {
  return endpoint.startsWith("\\\\.\\pipe\\") ? "命名管道" : "Unix 套接字";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "未知运行时错误";
}
