import type { JSX, ReactNode } from "react";

import { Icon, type IconName } from "./Icon.js";

export interface EmptyStateProps {
  readonly icon?: IconName;
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}

export function EmptyState({
  icon = "layers",
  title,
  description,
  actions,
}: EmptyStateProps): JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-state__art">
        <Icon name={icon} size={26} />
      </div>
      <h2>{title}</h2>
      {description === undefined ? null : <p>{description}</p>}
      {actions === undefined ? null : (
        <div className="empty-state__actions">{actions}</div>
      )}
    </div>
  );
}
