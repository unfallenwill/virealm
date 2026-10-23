import type { JSX } from "react";

import type { EnvironmentView } from "../../shared/contracts.js";
import {
  EnvironmentRow,
  type BusyAction,
  type EnvironmentActions,
} from "./EnvironmentRow.js";

export interface EnvironmentListProps {
  readonly environments: readonly EnvironmentView[];
  readonly busyById: Readonly<Record<string, BusyAction | undefined>>;
  readonly errorsById: Readonly<Record<string, string | undefined>>;
  readonly runtimeAvailable: boolean | undefined;
  readonly actions: EnvironmentActions;
}

export function EnvironmentList({
  environments,
  busyById,
  errorsById,
  runtimeAvailable,
  actions,
}: EnvironmentListProps): JSX.Element {
  return (
    <div className="env-list" role="list" aria-label="浏览器环境列表">
      <div className="env-list__head" aria-hidden="true">
        <span>环境</span>
        <span>最近启动</span>
        <span>区域与视口</span>
        <span>数据目录</span>
        <span />
      </div>
      {environments.map((environment) => (
        <EnvironmentRow
          key={environment.id}
          environment={environment}
          busy={busyById[environment.id]}
          actionError={errorsById[environment.id]}
          disabled={busyById[environment.id] !== undefined}
          runtimeAvailable={runtimeAvailable}
          actions={actions}
        />
      ))}
    </div>
  );
}
