import type { ButtonHTMLAttributes, JSX, ReactNode } from "react";

import { cx } from "../lib/cx.js";
import { Icon, type IconName } from "./Icon.js";

export type ButtonVariant =
  "primary" | "secondary" | "ghost" | "danger" | "danger-solid";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: "sm" | "md" | "lg";
  readonly icon?: IconName;
  readonly loading?: boolean;
  readonly children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled === true || loading}
      className={cx(
        "btn",
        `btn--${variant}`,
        size === "md" ? undefined : `btn--${size}`,
        className,
      )}
    >
      {loading ? (
        <span className="spinner" aria-hidden="true" />
      ) : icon === undefined ? null : (
        <Icon name={icon} size={size === "sm" ? 13 : 14} />
      )}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly icon: IconName;
  readonly label: string;
  readonly size?: number;
}

export function IconButton({
  icon,
  label,
  size = 16,
  className,
  type = "button",
  ...rest
}: IconButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      className={cx("icon-btn", className)}
      aria-label={label}
      title={label}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Spinner(): JSX.Element {
  return <span className="spinner" aria-hidden="true" />;
}
