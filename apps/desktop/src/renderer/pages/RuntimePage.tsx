import type { JSX } from "react";

import type {
  CapabilityState,
  IsolationCapabilityView,
  RuntimeStatusView,
} from "../../shared/contracts.js";
import { Button } from "../components/Button.js";
import { Icon } from "../components/Icon.js";
import { InlineAlert } from "../components/InlineAlert.js";
import { PageLoading } from "../components/LoadingState.js";
import { PageHeader } from "../components/PageHeader.js";
import { formatDateTime, isolationLabel } from "../lib/format.js";

const CAPABILITY_COPY: Readonly<
  Record<CapabilityState, { readonly label: string; readonly tone: string }>
> = {
  supported: { label: "可用", tone: "badge--success" },
  unsupported: { label: "不支持", tone: "badge--warning" },
  unavailable: { label: "当前不可用", tone: "badge--warning" },
  not_verified: { label: "未验证", tone: "" },
};

const ISOLATION_EXPLANATION: Readonly<Record<string, string>> = {
  managed:
    "把由运行时启动的 Chrome 进程树纳入 Job Object。它能保证退出时清理受管进程，但不改变账户权限。",
  restricted:
    "使用降权的受限令牌启动 Chrome。能减少对用户会话资源的访问，但可能影响依赖完整用户配置的功能。",
  app_container:
    "使用 AppContainer 与目录 ACL 限制文件系统与网络访问。隔离更强，但需要系统与运行时同时支持，兼容性最严格。",
};

export interface RuntimePageProps {
  readonly runtime: RuntimeStatusView | undefined;
  readonly busy: boolean;
  readonly actionError: string | undefined;
  readonly onRetry: () => void;
}

export function RuntimePage({
  runtime,
  busy,
  actionError,
  onRetry,
}: RuntimePageProps): JSX.Element {
  return (
    <div className="page">
      <PageHeader
        title="运行时"
        description="桌面应用通过本地 Process Runtime 管理 Chrome 进程边界。这里展示运行时实际报告的能力，而不是配置里的期望值。"
        actions={
          <Button
            variant={runtime?.available === false ? "primary" : "secondary"}
            icon="refresh"
            loading={busy}
            onClick={onRetry}
          >
            {runtime?.available === false ? "重试启动" : "重新检测"}
          </Button>
        }
      />

      {actionError === undefined ? null : (
        <InlineAlert tone="danger" title="无法重新连接运行时">
          {actionError}
        </InlineAlert>
      )}

      {runtime === undefined ? (
        <PageLoading label="正在检测本地运行时…" />
      ) : (
        <>
          <div className="runtime-hero">
            <section className="panel">
              <div className="panel__header">
                <h2 className="panel__title">连接状态</h2>
                <span
                  className={
                    runtime.available
                      ? "badge badge--success"
                      : "badge badge--danger"
                  }
                >
                  {runtime.available ? "可用" : "不可用"}
                </span>
              </div>
              <div className="panel__body">
                <div className="runtime-status-line">
                  {runtime.available ? "本地运行时已连接" : "本地运行时未运行"}
                </div>
                <p className="runtime-status-copy">
                  {runtime.available
                    ? "环境的状态查询、启动、停止与能力检测都通过这个本地命名管道完成。浏览器启动本身仍由 Browser Adapter 执行。"
                    : "桌面应用无法连接运行时，因此不能启动或停止 Chrome。已有环境记录仍可查看和编辑；修复运行时后可直接重试，无需重启应用。"}
                </p>
                {runtime.error === undefined ? null : (
                  <InlineAlert
                    tone="danger"
                    title="运行时错误"
                    className="verify-stale"
                  >
                    <span className="mono">{runtime.error.code}</span>
                    <div style={{ marginTop: 4 }}>{runtime.error.message}</div>
                  </InlineAlert>
                )}
                {!runtime.available ? (
                  <div className="diagnostic-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      icon="refresh"
                      loading={busy}
                      onClick={onRetry}
                    >
                      重试启动
                    </Button>
                  </div>
                ) : null}
                <div className="runtime-facts">
                  <Fact
                    label="可执行文件"
                    value={runtime.executablePath ?? "未找到"}
                  />
                  <Fact label="命名管道" value={runtime.pipePath} />
                  <Fact
                    label="最近检测"
                    value={formatDateTime(runtime.checkedAtUnixMs)}
                  />
                  <Fact
                    label="平台"
                    value={
                      runtime.platform === undefined
                        ? "—"
                        : `${runtime.platform.os} / ${runtime.platform.architecture}`
                    }
                  />
                  <Fact
                    label="权限"
                    value={
                      runtime.platform === undefined
                        ? "—"
                        : runtime.platform.elevated
                          ? "已提升"
                          : "普通用户"
                    }
                  />
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel__header">
                <h2 className="panel__title">状态含义</h2>
              </div>
              <div className="panel__body">
                <div className="kv" style={{ borderTop: 0 }}>
                  <div className="kv__row">
                    <div className="kv__key">可用</div>
                    <div className="kv__value">
                      已连接并可执行受管进程操作。
                    </div>
                  </div>
                  <div className="kv__row">
                    <div className="kv__key">不可用</div>
                    <div className="kv__value">
                      找不到可执行文件、管道未建立或运行时进程已退出。
                    </div>
                  </div>
                  <div className="kv__row">
                    <div className="kv__key">未验证</div>
                    <div className="kv__value">
                      运行时未报告该能力，不能视为已支持。
                    </div>
                  </div>
                </div>
                <p className="form-note">
                  <Icon name="info" size={13} />
                  <span>
                    运行时与服务端并非云服务。它只在这台 Windows
                    机器上运行，管道按应用实例隔离。
                  </span>
                </p>
              </div>
            </section>
          </div>

          <section className="panel settings-section">
            <div className="panel__header">
              <h2 className="panel__title">进程隔离能力</h2>
              <span style={{ color: "var(--text-tertiary)", fontSize: 11.5 }}>
                {runtime.isolation.length} 项
              </span>
            </div>
            <div className="panel__body panel__body--flush">
              {runtime.isolation.length === 0 ? (
                <div className="log-empty">运行时未报告隔离能力。</div>
              ) : (
                runtime.isolation.map((capability) => (
                  <CapabilityRow
                    key={capability.mode}
                    capability={capability}
                  />
                ))
              )}
            </div>
          </section>

          <section className="panel settings-section">
            <div className="panel__header">
              <h2 className="panel__title">关于“隔离”的边界</h2>
            </div>
            <div className="panel__body">
              <p className="runtime-status-copy" style={{ marginTop: 0 }}>
                Virealm
                通过浏览器层的配置与进程边界降低环境之间的相互影响。它不会修改操作系统内核，也不能保证完整的指纹隔离：字体、硬件、网络出口、扩展与其他系统信号仍可能暴露真实环境。桌面界面不会把“已设置”描述成“已验证”。
              </p>
              <div className="runtime-facts">
                {(["managed", "restricted", "app_container"] as const).map(
                  (mode) => (
                    <div key={mode}>
                      <div className="runtime-fact__label">
                        {isolationLabel(mode)}
                      </div>
                      <div
                        style={{
                          marginTop: 4,
                          color: "var(--text-secondary)",
                          fontSize: 11.5,
                          lineHeight: 1.55,
                        }}
                      >
                        {ISOLATION_EXPLANATION[mode]}
                      </div>
                    </div>
                  ),
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Fact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div>
      <div className="runtime-fact__label">{label}</div>
      <div className="runtime-fact__value" title={value}>
        {value}
      </div>
    </div>
  );
}

function CapabilityRow({
  capability,
}: {
  readonly capability: IsolationCapabilityView;
}): JSX.Element {
  const copy = CAPABILITY_COPY[capability.state];
  return (
    <div className="capability-row">
      <div>
        <div className="capability-row__name">
          {isolationLabel(capability.mode)}
        </div>
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--text-tertiary)" }}
        >
          {capability.mode}
        </div>
      </div>
      <span
        className={["badge", copy.tone].filter(Boolean).join(" ")}
        style={{ justifySelf: "start" }}
      >
        {copy.label}
      </span>
      <div className="capability-row__detail">
        {capability.detail ?? "运行时未提供进一步说明。"}
      </div>
    </div>
  );
}
