import { useMemo, useRef, useState, type JSX } from "react";

import type {
  EnvironmentView,
  RuntimeStatusView,
} from "../../shared/contracts.js";
import { Button } from "../components/Button.js";
import { EmptyState } from "../components/EmptyState.js";
import { EnvironmentList } from "../components/EnvironmentList.js";
import type {
  BusyAction,
  EnvironmentActions,
} from "../components/EnvironmentRow.js";
import { Icon } from "../components/Icon.js";
import { InlineAlert } from "../components/InlineAlert.js";
import { EnvironmentSkeleton } from "../components/LoadingState.js";
import { PageHeader } from "../components/PageHeader.js";

type StatusFilter = "all" | "running" | "stopped" | "problem";
type SortOrder = "updated" | "name" | "status";

export interface EnvironmentsPageProps {
  readonly loading: boolean;
  readonly loadError: string | undefined;
  readonly environments: readonly EnvironmentView[];
  readonly runtime: RuntimeStatusView | undefined;
  readonly busyById: Readonly<Record<string, BusyAction | undefined>>;
  readonly errorsById: Readonly<Record<string, string | undefined>>;
  readonly actions: EnvironmentActions;
  readonly onCreate: () => void;
  readonly onRetry: () => void;
  readonly onShowRuntime: () => void;
}

export function EnvironmentsPage({
  loading,
  loadError,
  environments,
  runtime,
  busyById,
  errorsById,
  actions,
  onCreate,
  onRetry,
  onShowRuntime,
}: EnvironmentsPageProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortOrder>("updated");
  const searchRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = environments.filter((environment) => {
      if (
        normalized.length > 0 &&
        !environment.name.toLowerCase().includes(normalized) &&
        !environment.id.toLowerCase().includes(normalized)
      ) {
        return false;
      }
      switch (filter) {
        case "running":
          return (
            environment.state === "running" ||
            environment.state === "starting" ||
            environment.state === "stopping"
          );
        case "stopped":
          return environment.state === "stopped";
        case "problem":
          return (
            environment.state === "failed" || environment.state === "unknown"
          );
        case "all":
          return true;
      }
    });
    return [...filtered].sort((left, right) => {
      if (sort === "name") {
        return left.name.localeCompare(right.name, "zh-CN");
      }
      if (sort === "status") {
        return stateRank(left) - stateRank(right);
      }
      return right.updatedAtUnixMs - left.updatedAtUnixMs;
    });
  }, [environments, filter, query, sort]);

  const filtering = query.trim().length > 0 || filter !== "all";
  const runtimeUnavailable = runtime !== undefined && !runtime.available;
  const empty = environments.length === 0;

  return (
    <div className="page">
      <PageHeader
        title="环境"
        description="每个环境拥有独立的 Chrome 配置目录、时区、语言与隔离策略。启停与配置验证均由本地运行时和 Browser Adapter 实际执行。"
        actions={
          <Button variant="primary" icon="plus" onClick={onCreate}>
            新建环境
            <kbd className="kbd">Ctrl+N</kbd>
          </Button>
        }
      />

      {runtimeUnavailable ? (
        <InlineAlert
          tone="warning"
          title="本地运行时不可用"
          actions={
            <Button size="sm" variant="secondary" onClick={onShowRuntime}>
              查看运行时
            </Button>
          }
        >
          {runtime.error?.message ??
            "环境列表仍可查看和编辑，但 Chrome 无法启动。"}
        </InlineAlert>
      ) : null}

      {loadError !== undefined ? (
        <InlineAlert
          tone="danger"
          title="无法读取环境列表"
          actions={
            <Button
              size="sm"
              variant="secondary"
              icon="refresh"
              onClick={onRetry}
            >
              重试
            </Button>
          }
        >
          {loadError}
        </InlineAlert>
      ) : null}

      {!empty && !loading ? (
        <div className="toolbar">
          <label className="search">
            <span className="visually-hidden">搜索环境</span>
            <Icon name="search" size={14} />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="搜索名称或 ID"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                }
              }}
            />
          </label>

          <div className="segmented" role="group" aria-label="按状态筛选">
            {(
              [
                ["all", "全部"],
                ["running", "运行中"],
                ["stopped", "已停止"],
                ["problem", "异常"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="segmented__item"
                aria-pressed={filter === value}
                onClick={() => {
                  setFilter(value);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="toolbar__spacer" />

          <span className="toolbar__meta">
            {filtering
              ? `${String(visible.length)} / ${String(environments.length)}`
              : `${String(environments.length)} 个环境`}
          </span>

          <label>
            <span className="visually-hidden">排序方式</span>
            <select
              className="select"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as SortOrder);
              }}
            >
              <option value="updated">最近更新</option>
              <option value="name">名称</option>
              <option value="status">状态</option>
            </select>
          </label>
        </div>
      ) : null}

      {loading && empty ? (
        <EnvironmentSkeleton />
      ) : empty ? (
        <EmptyState
          icon="layers"
          title="还没有浏览器环境"
          description="创建一个环境来隔离 Chrome 的配置目录、网络区域与页面视口。环境数据默认保留在本机，删除记录不会自动删除浏览器数据。"
          actions={
            <Button variant="primary" icon="plus" onClick={onCreate}>
              创建第一个环境
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon="search"
          title={filtering ? "没有匹配的环境" : "没有可显示的环境"}
          description={
            filtering
              ? `没有环境匹配当前的${query.trim().length > 0 ? `“${query.trim()}”` : "筛选条件"}。`
              : "调整搜索或筛选条件后再试。"
          }
          actions={
            <Button
              variant="secondary"
              onClick={() => {
                setQuery("");
                setFilter("all");
                searchRef.current?.focus();
              }}
            >
              清除筛选
            </Button>
          }
        />
      ) : (
        <EnvironmentList
          environments={visible}
          busyById={busyById}
          errorsById={errorsById}
          runtimeAvailable={runtime?.available}
          actions={actions}
        />
      )}
    </div>
  );
}

function stateRank(environment: EnvironmentView): number {
  switch (environment.state) {
    case "running":
      return 0;
    case "starting":
      return 1;
    case "stopping":
      return 2;
    case "failed":
      return 3;
    case "unknown":
      return 4;
    case "stopped":
      return 5;
  }
}
