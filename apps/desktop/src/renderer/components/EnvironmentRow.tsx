import type { JSX } from "react";

import type { EnvironmentView } from "../../shared/contracts.js";
import { cx } from "../lib/cx.js";
import {
  formatBrowser,
  formatLocaleConfig,
  formatRelative,
  formatViewport,
  phaseLabel,
  shortenPath,
} from "../lib/format.js";
import { Button, IconButton } from "./Button.js";
import { Icon } from "./Icon.js";
import { Menu, type MenuEntry } from "./Menu.js";
import { StatusIndicator } from "./StatusIndicator.js";

export type BusyAction = "launch" | "stop" | "restart" | "verify" | "delete";

export interface EnvironmentActions {
  onOpen: (environment: EnvironmentView) => void;
  onEdit: (environment: EnvironmentView) => void;
  onLaunch: (environment: EnvironmentView) => void;
  onStop: (environment: EnvironmentView) => void;
  onRestart: (environment: EnvironmentView) => void;
  onForceStop: (environment: EnvironmentView) => void;
  onVerify: (environment: EnvironmentView) => void;
  onDelete: (environment: EnvironmentView) => void;
  onShowDiagnostics: (environment: EnvironmentView) => void;
  onDismissError: (id: string) => void;
}

export interface EnvironmentRowProps {
  readonly environment: EnvironmentView;
  readonly busy: BusyAction | undefined;
  readonly actionError: string | undefined;
  readonly disabled: boolean;
  readonly runtimeAvailable: boolean | undefined;
  readonly actions: EnvironmentActions;
}

export function EnvironmentRow({
  environment,
  busy,
  actionError,
  disabled,
  runtimeAvailable,
  actions,
}: EnvironmentRowProps): JSX.Element {
  const active =
    environment.state === "running" ||
    environment.state === "starting" ||
    environment.state === "stopping";
  const failedLaunch =
    environment.lastLaunch !== undefined && !environment.lastLaunch.ok;
  const rowError =
    actionError ?? (failedLaunch ? environment.lastLaunch?.message : undefined);
  const showError = rowError !== undefined;
  const launchBusy = busy === "launch";
  const stopBusy = busy === "stop";
  const restartBusy = busy === "restart";
  const transient =
    environment.state === "starting" || environment.state === "stopping";

  const menuEntries: MenuEntry[] = [
    {
      label: "查看详情",
      icon: "layers",
      onSelect: () => {
        actions.onOpen(environment);
      },
    },
    {
      label: "编辑配置",
      icon: "edit",
      onSelect: () => {
        actions.onEdit(environment);
      },
    },
    {
      label: "验证配置",
      icon: "shield",
      disabled: environment.state !== "running",
      reason: "环境运行后可验证",
      onSelect: () => {
        actions.onVerify(environment);
      },
    },
    {
      kind: "separator",
    },
    {
      label: "重启环境",
      icon: "restart",
      disabled: environment.state !== "running",
      reason: "仅运行中的环境可重启",
      onSelect: () => {
        actions.onRestart(environment);
      },
    },
    {
      label: "强制停止",
      icon: "power",
      disabled: !active,
      reason: "仅运行中的环境可停止",
      onSelect: () => {
        actions.onForceStop(environment);
      },
    },
    {
      kind: "separator",
    },
    {
      label: "删除环境",
      icon: "trash",
      danger: true,
      disabled: active,
      reason: "请先停止环境",
      onSelect: () => {
        actions.onDelete(environment);
      },
    },
  ];

  return (
    <div className="env-row" role="listitem">
      <div className="env-row__identity">
        <div className="env-row__name-line">
          <StatusIndicator phase={environment.state} withLabel={false} />
          <button
            type="button"
            className="env-row__name"
            onClick={() => {
              actions.onOpen(environment);
            }}
            title={environment.name}
          >
            {environment.name}
          </button>
          {environment.pendingRestart ? (
            <span
              className="badge badge--warning"
              title="配置已保存，需要重启环境后生效"
            >
              <Icon name="restart" size={10} />
              待重启
            </span>
          ) : null}
        </div>
        <div className="env-row__sub">
          <span className="env-row__id mono">{environment.id}</span>
          <span style={{ color: "var(--border-strong)" }}>·</span>
          <span className="env-row__id">{phaseLabel(environment.state)}</span>
          <span style={{ color: "var(--border-strong)" }}>·</span>
          <span className="badge badge--mono">
            {formatBrowser(environment.browserVersion)}
          </span>
        </div>
      </div>

      <div className="env-row__cell env-row__cell--launch">
        <span className="env-row__cell-label">最近启动</span>
        {environment.lastLaunch === undefined ? (
          <span
            className="env-row__truncate"
            style={{ color: "var(--text-tertiary)" }}
          >
            尚未启动
          </span>
        ) : (
          <span
            className={cx(
              "env-row__note",
              environment.lastLaunch.ok ? undefined : "env-row__note--danger",
            )}
            title={environment.lastLaunch.message}
          >
            <Icon
              name={environment.lastLaunch.ok ? "check" : "warning"}
              size={12}
            />
            <span className="env-row__truncate">
              {formatRelative(environment.lastLaunch.atUnixMs)} ·{" "}
              {environment.lastLaunch.ok ? "成功" : "失败"}
            </span>
          </span>
        )}
      </div>

      <div className="env-row__cell env-row__cell--locale">
        <span className="env-row__cell-label">区域与视口</span>
        <span
          className="env-row__truncate"
          title={formatLocaleConfig(environment)}
        >
          {formatLocaleConfig(environment)}
        </span>
        <span
          className="env-row__truncate"
          style={{ color: "var(--text-tertiary)" }}
        >
          {formatViewport(environment)}
        </span>
      </div>

      <div
        className="env-row__cell env-row__cell--dir"
        title={environment.dataDir}
      >
        <span className="env-row__cell-label">数据目录</span>
        <span className="env-row__truncate mono" style={{ fontSize: 10.5 }}>
          {shortenPath(environment.dataDir)}
        </span>
      </div>

      <div className="env-row__actions">
        {launchBusy || restartBusy ? (
          <Button size="sm" variant="secondary" loading>
            {restartBusy ? "重启中…" : "启动中…"}
          </Button>
        ) : stopBusy ? (
          <Button size="sm" variant="secondary" loading>
            停止中…
          </Button>
        ) : environment.state === "running" ? (
          <Button
            size="sm"
            variant="secondary"
            icon="stop"
            disabled={disabled || busy !== undefined}
            onClick={() => {
              actions.onStop(environment);
            }}
            title="优雅停止 Chrome；若未退出会按现有策略升级"
          >
            停止
          </Button>
        ) : environment.state === "starting" ||
          environment.state === "stopping" ? (
          <Button size="sm" variant="secondary" loading>
            {transient ? phaseLabel(environment.state) : "处理中"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            icon="play"
            disabled={
              disabled || busy !== undefined || runtimeAvailable !== true
            }
            title={
              runtimeAvailable === true
                ? "启动独立的 Chrome 环境"
                : runtimeAvailable === false
                  ? "本地运行时不可用，无法启动"
                  : "正在检测本地运行时"
            }
            onClick={() => {
              actions.onLaunch(environment);
            }}
          >
            {environment.state === "failed" ? "重试启动" : "启动"}
          </Button>
        )}
        <Menu label={`${environment.name} 的更多操作`} entries={menuEntries} />
      </div>

      {showError ? (
        <div className="env-row__error" role="alert">
          <Icon name="warning" size={14} />
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {rowError}
          </span>
          <div className="env-row__error-actions">
            {actionError !== undefined ? (
              <>
                <button
                  type="button"
                  className="section__action"
                  onClick={() => {
                    actions.onShowDiagnostics(environment);
                  }}
                >
                  诊断
                </button>
                <IconButton
                  icon="close"
                  label="关闭错误"
                  size={13}
                  onClick={() => {
                    actions.onDismissError(environment.id);
                  }}
                />
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
