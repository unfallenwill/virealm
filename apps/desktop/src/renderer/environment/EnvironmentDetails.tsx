import { useEffect, useState, type JSX, type ReactNode } from "react";

import type {
  DiagnosticsView,
  EnvironmentView,
  RuntimeStatusView,
} from "../../shared/contracts.js";
import {
  isBrowserCompatibleIsolation,
  isMacosPlatform,
} from "../../shared/isolation.js";
import { Button, IconButton } from "../components/Button.js";
import { Drawer } from "../components/Drawer.js";
import { Icon } from "../components/Icon.js";
import { InlineAlert } from "../components/InlineAlert.js";
import type { BusyAction } from "../components/EnvironmentRow.js";
import {
  configValue,
  copyText,
  formatBytes,
  formatClock,
  formatDateTime,
  formatBrowser,
  formatRelative,
  isolationLabel,
  phaseLabel,
} from "../lib/format.js";
import { StatusIndicator } from "../components/StatusIndicator.js";
import { PageVerification, VerificationTable } from "./VerificationTable.js";

export type DetailTab = "overview" | "config" | "verification" | "diagnostics";

const TABS: readonly { readonly id: DetailTab; readonly label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "config", label: "配置" },
  { id: "verification", label: "验证" },
  { id: "diagnostics", label: "诊断" },
];

export interface EnvironmentDetailsProps {
  readonly environment: EnvironmentView;
  readonly runtime: RuntimeStatusView | undefined;
  readonly busy: BusyAction | undefined;
  readonly initialTab: DetailTab;
  readonly diagnostics: DiagnosticsView | undefined;
  readonly diagnosticsLoading: boolean;
  readonly diagnosticsError: string | undefined;
  readonly onRefreshDiagnostics: () => void;
  readonly onRequestClose: () => void;
  readonly onEdit: () => void;
  readonly onLaunch: () => void;
  readonly onStop: () => void;
  readonly onRestart: () => void;
  readonly onVerify: () => void;
  readonly onDelete: () => void;
  readonly onShowRuntime: () => void;
}

export function EnvironmentDetails({
  environment,
  runtime,
  busy,
  initialTab,
  diagnostics,
  diagnosticsLoading,
  diagnosticsError,
  onRefreshDiagnostics,
  onRequestClose,
  onEdit,
  onLaunch,
  onStop,
  onRestart,
  onVerify,
  onDelete,
  onShowRuntime,
}: EnvironmentDetailsProps): JSX.Element {
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [copied, setCopied] = useState<string | undefined>(undefined);
  const running = environment.state === "running";
  const active =
    running ||
    environment.state === "starting" ||
    environment.state === "stopping";

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (tab === "diagnostics" && diagnostics === undefined) {
      onRefreshDiagnostics();
    }
  }, [tab, diagnostics, onRefreshDiagnostics]);

  const copy = async (key: string, value: string): Promise<void> => {
    const ok = await copyText(value);
    setCopied(ok ? key : undefined);
    if (ok) {
      window.setTimeout(() => {
        setCopied((current) => (current === key ? undefined : current));
      }, 1600);
    }
  };

  const primary = active ? (
    <Button
      variant="secondary"
      icon="stop"
      loading={busy === "stop"}
      disabled={busy !== undefined}
      onClick={onStop}
    >
      停止环境
    </Button>
  ) : (
    <Button
      variant="primary"
      icon="play"
      loading={busy === "launch"}
      disabled={busy !== undefined || runtime?.available !== true}
      onClick={onLaunch}
      title={
        runtime?.available === false
          ? "本地运行时不可用，无法启动"
          : runtime === undefined
            ? "正在检测本地运行时"
            : "启动独立的 Chrome 环境"
      }
    >
      启动环境
    </Button>
  );

  return (
    <Drawer
      title={environment.name}
      subtitle={environment.id}
      eyebrow={
        <>
          <StatusIndicator phase={environment.state} />
          <span className="badge badge--mono">
            {formatBrowser(environment.browserVersion)}
          </span>
          {environment.pendingRestart ? (
            <span className="badge badge--warning">
              <Icon name="restart" size={10} />
              待重启
            </span>
          ) : null}
        </>
      }
      wide
      onRequestClose={onRequestClose}
      footer={
        <>
          <Button
            variant="ghost"
            className="btn--danger"
            icon="trash"
            onClick={onDelete}
            disabled={active || busy !== undefined}
            title={active ? "请先停止环境再删除" : "删除环境记录"}
          >
            删除
          </Button>
          <span className="drawer__footer-spacer" />
          <Button icon="edit" onClick={onEdit} disabled={busy !== undefined}>
            编辑配置
          </Button>
          {primary}
        </>
      }
    >
      <div className="tabs" role="tablist" aria-label="环境详情">
        {TABS.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`detail-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`detail-panel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            className="tab"
            onClick={() => {
              setTab(entry.id);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
                return;
              }
              event.preventDefault();
              const offset = event.key === "ArrowRight" ? 1 : -1;
              const next = TABS[(index + offset + TABS.length) % TABS.length];
              if (next !== undefined) {
                setTab(next.id);
                document.getElementById(`detail-tab-${next.id}`)?.focus();
              }
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`detail-panel-${tab}`}
        aria-labelledby={`detail-tab-${tab}`}
      >
        {tab === "overview" ? (
          <Overview
            environment={environment}
            busy={busy}
            copied={copied}
            onCopy={copy}
            onVerify={onVerify}
            onRestart={onRestart}
            onShowRuntime={onShowRuntime}
          />
        ) : null}
        {tab === "config" ? (
          <ConfigPanel environment={environment} runtime={runtime} />
        ) : null}
        {tab === "verification" ? (
          <VerificationPanel
            environment={environment}
            busy={busy}
            onVerify={onVerify}
          />
        ) : null}
        {tab === "diagnostics" ? (
          <DiagnosticsPanel
            environment={environment}
            runtime={runtime}
            diagnostics={diagnostics}
            loading={diagnosticsLoading}
            error={diagnosticsError}
            copied={copied}
            onCopy={copy}
            onRefresh={onRefreshDiagnostics}
            onShowRuntime={onShowRuntime}
          />
        ) : null}
      </div>
    </Drawer>
  );
}

interface OverviewProps {
  readonly environment: EnvironmentView;
  readonly busy: BusyAction | undefined;
  readonly copied: string | undefined;
  readonly onCopy: (key: string, value: string) => Promise<void>;
  readonly onVerify: () => void;
  readonly onRestart: () => void;
  readonly onShowRuntime: () => void;
}

function Overview({
  environment,
  busy,
  copied,
  onCopy,
  onVerify,
  onRestart,
  onShowRuntime,
}: OverviewProps): JSX.Element {
  const running = environment.state === "running";
  return (
    <div>
      <div className="detail-state">
        <div className="detail-state__main">
          <StatusIndicator
            phase={environment.state}
            className="detail-state__status"
          />
          <div className="detail-state__meta">
            {environment.state === "running"
              ? [
                  environment.pid === undefined
                    ? undefined
                    : `PID ${String(environment.pid)}`,
                  environment.startedAtUnixMs === undefined
                    ? undefined
                    : `启动于 ${formatDateTime(environment.startedAtUnixMs)}`,
                  environment.cdp.connected ? "CDP 已连接" : "CDP 未连接",
                ]
                  .filter((part): part is string => part !== undefined)
                  .join(" · ")
              : (environment.lastError?.message ??
                (environment.state === "failed"
                  ? "最近一次启动失败，可查看诊断了解原因。"
                  : "Chrome 未运行。启动后才会创建并占用此环境的数据目录。"))}
          </div>
        </div>
        <div className="detail-state__actions">
          {running ? (
            <Button
              size="sm"
              icon="shield"
              loading={busy === "verify"}
              disabled={busy !== undefined}
              onClick={onVerify}
            >
              验证配置
            </Button>
          ) : null}
          {running ? (
            <Button
              size="sm"
              variant="ghost"
              icon="restart"
              loading={busy === "restart"}
              disabled={busy !== undefined}
              onClick={onRestart}
            >
              重启
            </Button>
          ) : null}
        </div>
      </div>

      {environment.pendingRestart ? (
        <InlineAlert
          tone="info"
          title="有配置需要重启后生效"
          actions={
            <Button
              size="sm"
              variant="secondary"
              icon="restart"
              disabled={busy !== undefined || !running}
              onClick={onRestart}
            >
              立即重启
            </Button>
          }
        >
          你保存的部分配置无法热应用。当前浏览器仍在运行旧配置，停止并重新启动后才会使用新配置。
        </InlineAlert>
      ) : null}

      {environment.warnings.map((warning) => (
        <InlineAlert key={warning} tone="warning" className="verify-stale">
          {warning}
        </InlineAlert>
      ))}

      {environment.lastError !== undefined ? (
        <InlineAlert
          tone="danger"
          title="最近一次错误"
          className="verify-stale"
        >
          <span className="mono">{environment.lastError.code}</span>
          <span> · {environment.lastError.message}</span>
        </InlineAlert>
      ) : null}

      <div className="section">
        <div className="section__header">
          <span className="section__title">环境</span>
        </div>
        <div className="kv">
          <KvRow label="名称">{environment.name}</KvRow>
          <KvRow
            label="环境 ID"
            mono
            copyKey="id"
            copied={copied}
            onCopy={onCopy}
          >
            {environment.id}
          </KvRow>
          <KvRow label="Chrome">
            {formatBrowser(environment.browserVersion)}
            {environment.browser.executablePath === undefined ? (
              <span style={{ color: "var(--text-tertiary)" }}> · 自动发现</span>
            ) : null}
          </KvRow>
          {environment.cdp.endpointOrigin === undefined ? null : (
            <KvRow label="CDP 端点" mono>
              {environment.cdp.endpointOrigin}
            </KvRow>
          )}
          <KvRow
            label="数据目录"
            mono
            copyKey="dir"
            copied={copied}
            onCopy={onCopy}
          >
            {environment.dataDir}
          </KvRow>
          <KvRow label="创建时间">
            {formatDateTime(environment.createdAtUnixMs)}
          </KvRow>
          <KvRow label="最近更新">
            {formatDateTime(environment.updatedAtUnixMs)}
          </KvRow>
        </div>
      </div>

      <div className="section">
        <div className="section__header">
          <span className="section__title">最近启动</span>
        </div>
        {environment.lastLaunch === undefined ? (
          <p style={{ color: "var(--text-tertiary)", fontSize: 12 }}>
            此环境尚未通过桌面应用启动过。
          </p>
        ) : (
          <div className="kv">
            <KvRow label="时间">
              {formatDateTime(environment.lastLaunch.atUnixMs)}
              <span style={{ color: "var(--text-tertiary)" }}>
                {" "}
                · {formatRelative(environment.lastLaunch.atUnixMs)}
              </span>
            </KvRow>
            <KvRow label="结果">
              <span
                style={{
                  color: environment.lastLaunch.ok
                    ? "var(--success)"
                    : "var(--danger)",
                }}
              >
                {environment.lastLaunch.ok ? "成功" : "失败"}
              </span>
              {environment.lastLaunch.code === undefined ? null : (
                <span className="mono"> · {environment.lastLaunch.code}</span>
              )}
            </KvRow>
            <KvRow label="说明">{environment.lastLaunch.message}</KvRow>
          </div>
        )}
      </div>

      {environment.state === "unknown" ? (
        <InlineAlert
          tone="warning"
          title="无法确定实际状态"
          className="verify-stale"
          actions={
            <Button size="sm" variant="secondary" onClick={onShowRuntime}>
              查看运行时
            </Button>
          }
        >
          桌面应用无法查询该环境的实际进程状态。界面不会把缓存状态当作运行状态，请检查本地运行时。
        </InlineAlert>
      ) : null}
    </div>
  );
}

function ConfigPanel({
  environment,
  runtime,
}: {
  readonly environment: EnvironmentView;
  readonly runtime: RuntimeStatusView | undefined;
}): JSX.Element {
  const args = environment.launch?.additionalArguments ?? [];
  return (
    <div>
      <InlineAlert tone="info" title="这是期望配置，不代表已生效">
        运行中的环境已成功热应用的字段会显示在“验证”中。需要重启的修改会保留为待重启状态，直到你停止并重新启动环境。
      </InlineAlert>
      <div className="section">
        <div className="section__header">
          <span className="section__title">浏览器</span>
        </div>
        <div className="kv">
          <KvRow label="Chrome 路径" mono>
            {environment.browser.executablePath ?? "自动发现最新 Chrome"}
          </KvRow>
          <KvRow label="数据目录" mono>
            {environment.dataDir}
          </KvRow>
          <KvRow label="额外启动参数" mono>
            {args.length === 0 ? "无" : args.join(" ")}
          </KvRow>
        </div>
      </div>

      <div className="section">
        <div className="section__header">
          <span className="section__title">区域与页面</span>
        </div>
        <div className="kv">
          <KvRow label="时区">{environment.timezone ?? "系统默认"}</KvRow>
          <KvRow label="语言">{environment.locale ?? "系统默认"}</KvRow>
          <KvRow label="视口">
            {environment.viewport === undefined
              ? "浏览器窗口默认"
              : `${String(environment.viewport.width)} × ${String(environment.viewport.height)}${
                  environment.viewport.deviceScaleFactor === undefined
                    ? ""
                    : ` @ ${String(environment.viewport.deviceScaleFactor)}×`
                }`}
          </KvRow>
          <KvRow label="地理位置">
            {environment.geolocation === undefined
              ? "未覆盖"
              : `${environment.geolocation.latitude.toFixed(4)}, ${environment.geolocation.longitude.toFixed(4)}${
                  environment.geolocation.accuracy === undefined
                    ? ""
                    : ` · ±${String(environment.geolocation.accuracy)} m`
                }`}
          </KvRow>
        </div>
      </div>

      <div className="section">
        <div className="section__header">
          <span className="section__title">运行时策略</span>
        </div>
        <div className="kv">
          <KvRow label="隔离模式">
            {isolationLabel(
              environment.runtimePolicy.isolation,
              runtime?.platform?.os,
            )}
            <span className="mono" style={{ color: "var(--text-tertiary)" }}>
              {" "}
              · {environment.runtimePolicy.isolation}
            </span>
            {isBrowserCompatibleIsolation(
              environment.runtimePolicy.isolation,
            ) ? null : (
              <span className="badge badge--warning">
                {isMacosPlatform(runtime?.platform?.os)
                  ? "macOS 不支持"
                  : "浏览器不兼容"}
              </span>
            )}
          </KvRow>
          <KvRow label="进程上限">
            {environment.runtimePolicy.maxProcesses === undefined
              ? "未限制"
              : String(environment.runtimePolicy.maxProcesses)}
          </KvRow>
          <KvRow label="内存上限">
            {formatBytes(environment.runtimePolicy.memoryLimitBytes)}
          </KvRow>
        </div>
      </div>

      <p className="form-note">
        <Icon name="info" size={13} />
        <span>
          隔离模式限制的是进程边界，不是完整的操作系统指纹隔离。浏览器层模拟无法掩盖全部硬件、字体或网络特征。
        </span>
      </p>
    </div>
  );
}

function VerificationPanel({
  environment,
  busy,
  onVerify,
}: {
  readonly environment: EnvironmentView;
  readonly busy: BusyAction | undefined;
  readonly onVerify: () => void;
}): JSX.Element {
  const verification = environment.verification;
  if (verification === undefined) {
    return (
      <div className="verify-empty">
        <p>还没有配置验证结果。</p>
        <p style={{ marginTop: 4, color: "var(--text-tertiary)" }}>
          验证会在运行中的浏览器页面里读取实际生效的时区、语言与视口。
        </p>
        <div className="verify-empty__actions">
          <Button
            size="sm"
            variant="secondary"
            icon="shield"
            loading={busy === "verify"}
            disabled={environment.state !== "running" || busy !== undefined}
            onClick={onVerify}
          >
            {environment.state === "running"
              ? "验证当前配置"
              : "环境运行后可验证"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {verification.stale ? (
        <InlineAlert
          tone="warning"
          title="验证结果已过期"
          className="verify-stale"
          actions={
            <Button
              size="sm"
              variant="secondary"
              icon="refresh"
              loading={busy === "verify"}
              disabled={environment.state !== "running" || busy !== undefined}
              onClick={onVerify}
            >
              重新验证
            </Button>
          }
        >
          环境已停止或配置已变更，下面的结果来自{" "}
          {formatDateTime(verification.capturedAtUnixMs)}，不能代表当前浏览器。
        </InlineAlert>
      ) : null}

      <div className="section">
        <div className="section__header">
          <span className="section__title">聚合结果</span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              color: "var(--text-tertiary)",
            }}
          >
            采集于 {formatDateTime(verification.capturedAtUnixMs)}
          </span>
        </div>
        <VerificationTable fields={verification.fields} />
      </div>

      {verification.pages.map((page) => (
        <PageVerification key={page.pageId} page={page} />
      ))}

      <p className="form-note">
        <Icon name="info" size={13} />
        <span>
          “已验证”表示在页面上下文中观测到的值符合期望；“已应用”表示配置已下发但未能从页面读取确认；“不支持”表示当前浏览器或平台无法提供该能力。
        </span>
      </p>
    </div>
  );
}

function DiagnosticsPanel({
  environment,
  runtime,
  diagnostics,
  loading,
  error,
  copied,
  onCopy,
  onRefresh,
  onShowRuntime,
}: {
  readonly environment: EnvironmentView;
  readonly runtime: RuntimeStatusView | undefined;
  readonly diagnostics: DiagnosticsView | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly copied: string | undefined;
  readonly onCopy: (key: string, value: string) => Promise<void>;
  readonly onRefresh: () => void;
  readonly onShowRuntime: () => void;
}): JSX.Element {
  const logs = diagnostics?.logs ?? [];
  const report = buildDiagnosticReport(environment, runtime, diagnostics);

  return (
    <div>
      {error === undefined ? null : (
        <InlineAlert
          tone="danger"
          title="无法读取诊断信息"
          className="verify-stale"
        >
          {error}
        </InlineAlert>
      )}

      <div className="section">
        <div className="section__header">
          <span className="section__title">运行时</span>
          <button
            type="button"
            className="section__action"
            onClick={onShowRuntime}
          >
            打开运行时页面
          </button>
        </div>
        <div className="kv">
          <KvRow label="状态">
            {runtime === undefined
              ? "检测中"
              : runtime.available
                ? "已连接"
                : "不可用"}
          </KvRow>
          <KvRow label="可执行文件" mono>
            {runtime?.executablePath ?? "未找到"}
          </KvRow>
          <KvRow
            label={
              isMacosPlatform(runtime?.platform?.os)
                ? "Unix 套接字"
                : "命名管道"
            }
            mono
          >
            {runtime?.pipePath ?? "—"}
          </KvRow>
          <KvRow label="平台">
            {runtime?.platform === undefined
              ? "—"
              : `${runtime.platform.os} · ${runtime.platform.architecture}${
                  runtime.platform.elevated ? " · 已提升" : ""
                }${runtime.platform.osVersion === undefined ? "" : ` · ${runtime.platform.osVersion}`}`}
          </KvRow>
          {runtime?.error === undefined ? null : (
            <KvRow label="错误">
              <span className="mono">{runtime.error.code}</span>
              <div style={{ marginTop: 2 }}>{runtime.error.message}</div>
            </KvRow>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section__header">
          <span className="section__title">最近日志</span>
          <button type="button" className="section__action" onClick={onRefresh}>
            刷新
          </button>
        </div>
        {loading && logs.length === 0 ? (
          <div className="log-empty">正在读取日志…</div>
        ) : logs.length === 0 ? (
          <div className="log-empty">没有与此环境相关的日志。</div>
        ) : (
          <div className="log-list" role="log" aria-label="环境日志">
            {logs.map((entry, index) => (
              <div
                className="log-row"
                key={`${String(entry.atUnixMs)}-${String(index)}`}
              >
                <span className="log-row__time">
                  {formatClock(entry.atUnixMs)}
                </span>
                <span
                  className={`log-row__level log-row__level--${entry.level}`}
                >
                  {entry.level}
                </span>
                <span className="log-row__message">
                  <span style={{ color: "var(--text-tertiary)" }}>
                    [{entry.code}]
                  </span>{" "}
                  {entry.message}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="diagnostic-actions">
          <Button
            size="sm"
            variant="secondary"
            icon={copied === "diagnostics" ? "check" : "copy"}
            onClick={() => {
              void onCopy("diagnostics", report);
            }}
          >
            {copied === "diagnostics" ? "已复制" : "复制诊断信息"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            loading={loading}
            onClick={onRefresh}
          >
            重新收集
          </Button>
        </div>
        <p className="form-note">
          <Icon name="lock" size={13} />
          <span>
            诊断信息只包含环境标识、状态、运行时能力与脱敏日志。不会包含
            Cookie、密码或访问令牌。
          </span>
        </p>
      </div>
    </div>
  );
}

function KvRow({
  label,
  mono = false,
  copyKey,
  copied,
  onCopy,
  children,
}: {
  readonly label: string;
  readonly mono?: boolean;
  readonly copyKey?: string;
  readonly copied?: string | undefined;
  readonly onCopy?: (key: string, value: string) => Promise<void>;
  readonly children: ReactNode;
}): JSX.Element {
  const value = typeof children === "string" ? children : undefined;
  return (
    <div className="kv__row">
      <div className="kv__key">{label}</div>
      <div className={mono ? "kv__value kv__value--mono" : "kv__value"}>
        {copyKey !== undefined &&
        value !== undefined &&
        onCopy !== undefined ? (
          <div className="copy-line">
            <span title={value}>{value}</span>
            <IconButton
              icon={copied === copyKey ? "check" : "copy"}
              label={copied === copyKey ? "已复制" : `复制${label}`}
              size={12}
              onClick={() => {
                void onCopy(copyKey, value);
              }}
            />
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

export function buildDiagnosticReport(
  environment: EnvironmentView,
  runtime: RuntimeStatusView | undefined,
  diagnostics: DiagnosticsView | undefined,
): string {
  const lines: string[] = [
    "Virealm 诊断信息",
    `环境: ${environment.name} (${environment.id})`,
    `状态: ${phaseLabel(environment.state)}`,
    `PID: ${environment.pid === undefined ? "—" : String(environment.pid)}`,
    `Chrome: ${formatBrowser(environment.browserVersion)}`,
    `数据目录: ${environment.dataDir}`,
    `CDP: ${environment.cdp.connected ? "已连接" : "未连接"} ${environment.cdp.endpointOrigin ?? ""}`,
    `时区/语言: ${configValue(environment.timezone)} / ${configValue(environment.locale)}`,
    `视口: ${environment.viewport === undefined ? "默认" : `${String(environment.viewport.width)}x${String(environment.viewport.height)}`}`,
    `隔离: ${environment.runtimePolicy.isolation}`,
    environment.lastError === undefined
      ? "最近错误: 无"
      : `最近错误: ${environment.lastError.code} ${environment.lastError.message}`,
    "",
    `运行时: ${runtime === undefined ? "检测中" : runtime.available ? "可用" : "不可用"}`,
    `运行时路径: ${runtime?.executablePath ?? "未找到"}`,
    `运行时错误: ${runtime?.error === undefined ? "无" : `${runtime.error.code} ${runtime.error.message}`}`,
    "",
    "日志:",
  ];
  const logs = diagnostics?.logs ?? [];
  if (logs.length === 0) {
    lines.push("(无)");
  } else {
    for (const entry of logs) {
      lines.push(
        `${formatDateTime(entry.atUnixMs)} [${entry.level}] [${entry.code}] ${entry.message}`,
      );
    }
  }
  return lines.join("\n");
}
