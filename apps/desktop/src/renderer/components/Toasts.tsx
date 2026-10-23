import type { JSX } from "react";

import { Icon } from "./Icon.js";
import { IconButton } from "./Button.js";

export type ToastTone = "success" | "warning" | "error" | "info";

export interface ToastItem {
  readonly id: number;
  readonly tone: ToastTone;
  readonly title: string;
  readonly detail?: string;
}

export interface ToastsProps {
  readonly toasts: readonly ToastItem[];
  readonly onDismiss: (id: number) => void;
}

export function Toasts({ toasts, onDismiss }: ToastsProps): JSX.Element {
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div className={`toast toast--${toast.tone}`} key={toast.id}>
          <Icon
            name={
              toast.tone === "success"
                ? "check"
                : toast.tone === "error"
                  ? "error"
                  : toast.tone === "warning"
                    ? "warning"
                    : "info"
            }
            size={16}
            className="toast__icon"
          />
          <div
            className="toast__body"
            role={
              toast.tone === "error" || toast.tone === "warning"
                ? "alert"
                : undefined
            }
          >
            <div className="toast__title">{toast.title}</div>
            {toast.detail === undefined ? null : (
              <div className="toast__detail">{toast.detail}</div>
            )}
          </div>
          <IconButton
            icon="close"
            label="关闭通知"
            size={13}
            onClick={() => {
              onDismiss(toast.id);
            }}
          />
        </div>
      ))}
    </div>
  );
}
