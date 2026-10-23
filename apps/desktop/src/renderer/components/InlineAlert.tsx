import type { JSX, ReactNode } from "react";

import { cx } from "../lib/cx.js";
import { Icon } from "./Icon.js";

export type AlertTone = "info" | "warning" | "danger" | "success";

export interface InlineAlertProps {
  readonly tone?: AlertTone;
  readonly title?: string;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly live?: "polite" | "assertive" | "off";
}

export function InlineAlert({
  tone = "info",
  title,
  children,
  actions,
  className,
  live = "off",
}: InlineAlertProps): JSX.Element {
  const icon =
    tone === "success"
      ? "check"
      : tone === "danger" || tone === "warning"
        ? "warning"
        : "info";
  return (
    <div
      className={cx("alert", `alert--${tone}`, className)}
      role={live === "off" ? undefined : tone === "danger" ? "alert" : "status"}
      aria-live={live === "off" ? undefined : live}
    >
      <Icon name={icon} size={16} className="alert__icon" />
      <div className="alert__body">
        {title === undefined ? null : (
          <div className="alert__title">{title}</div>
        )}
        {children === undefined ? null : (
          <div className="alert__text">{children}</div>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="alert__actions">{actions}</div>
      )}
    </div>
  );
}
