import type { JSX, ReactNode } from "react";

export interface PageHeaderProps {
  readonly title: string;
  readonly description: string;
  readonly actions?: ReactNode;
}

export function PageHeader({
  title,
  description,
  actions,
}: PageHeaderProps): JSX.Element {
  return (
    <header className="page-header">
      <div className="page-header__heading">
        <h1 className="page-header__title">{title}</h1>
        <p className="page-header__description">{description}</p>
      </div>
      {actions === undefined ? null : (
        <div className="page-header__actions">{actions}</div>
      )}
    </header>
  );
}
