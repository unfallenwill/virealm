import type { JSX } from "react";

import type { RuntimeStatusView } from "../../shared/contracts.js";
import { Icon, type IconName } from "./Icon.js";
import { StatusIndicator } from "./StatusIndicator.js";

export type ViewName = "environments" | "runtime" | "settings";

export interface SidebarProps {
  readonly view: ViewName;
  readonly environmentCount: number;
  readonly runtime: RuntimeStatusView | undefined;
  readonly onNavigate: (view: ViewName) => void;
}

interface NavItem {
  readonly view: ViewName;
  readonly label: string;
  readonly icon: IconName;
  readonly hint: string;
}

const NAV_ITEMS: readonly NavItem[] = [
  {
    view: "environments",
    label: "环境",
    icon: "layers",
    hint: "管理本地浏览器环境",
  },
  {
    view: "runtime",
    label: "运行时",
    icon: "activity",
    hint: "查看进程运行时与隔离能力",
  },
];

export function Sidebar({
  view,
  environmentCount,
  runtime,
  onNavigate,
}: SidebarProps): JSX.Element {
  const runtimePhase =
    runtime === undefined
      ? "starting"
      : runtime.available
        ? "running"
        : "failed";
  const runtimeText =
    runtime === undefined ? "检测中" : runtime.available ? "已连接" : "不可用";

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand__mark" aria-hidden="true">
          <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
            <path
              d="M16 3.5 28.5 9.25 16 15 3.5 9.25 16 3.5Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <path
              d="m3.5 15 12.5 5.75L28.5 15"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
              opacity="0.72"
            />
            <path
              d="m3.5 20.5 12.5 5.75L28.5 20.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
              opacity="0.4"
            />
          </svg>
        </div>
        <div className="brand__text">
          <div className="brand__name">Virealm</div>
          <div className="brand__caption">Local environments</div>
        </div>
      </div>

      <nav className="nav" aria-label="主导航">
        <div className="nav__label">工作区</div>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.view}
            type="button"
            className="nav__item"
            aria-current={view === item.view ? "page" : undefined}
            aria-label={item.label}
            title={item.hint}
            onClick={() => {
              onNavigate(item.view);
            }}
          >
            <Icon name={item.icon} size={16} />
            <span>{item.label}</span>
            {item.view === "environments" && environmentCount > 0 ? (
              <span className="nav__count">{environmentCount}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="sidebar__spacer" />

      <button
        type="button"
        className="sidebar__runtime"
        onClick={() => {
          onNavigate("runtime");
        }}
        aria-label={`本地运行时：${runtimeText}，查看状态与隔离能力`}
        title={`本地运行时：${runtimeText}`}
      >
        <div className="sidebar__runtime-title">
          <StatusIndicator phase={runtimePhase} withLabel={false} />
          <span>本地运行时</span>
        </div>
        <div className="sidebar__runtime-detail">{runtimeText}</div>
      </button>

      <div className="sidebar__footer">
        <button
          type="button"
          className="nav__item"
          aria-current={view === "settings" ? "page" : undefined}
          aria-label="设置"
          title="设置 (Ctrl+,)"
          onClick={() => {
            onNavigate("settings");
          }}
        >
          <Icon name="sliders" size={16} />
          <span>设置</span>
          <span className="nav__count" aria-hidden="true">
            <Icon name="chevron-right" size={11} />
          </span>
        </button>
      </div>
    </aside>
  );
}
