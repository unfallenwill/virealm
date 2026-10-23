import { useEffect, useRef, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "./Button.js";

export interface ConfirmDialogProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly busy?: boolean;
  readonly confirmDisabled?: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  readonly footerExtra?: ReactNode;
  readonly labelledBy?: string;
}

/** Small modal for destructive or discard confirmations. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "取消",
  destructive = false,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onClose,
  footerExtra,
  labelledBy = "confirm-title",
}: ConfirmDialogProps): JSX.Element {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, []);

  return createPortal(
    <>
      <div className="overlay" aria-hidden="true" />
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        <div className="dialog__header">
          <h2 className="dialog__title" id={labelledBy}>
            {title}
          </h2>
        </div>
        <div className="dialog__body">{children}</div>
        <div className="dialog__footer">
          {footerExtra}
          <Button onClick={onClose} disabled={busy} autoFocus>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger-solid" : "primary"}
            onClick={onConfirm}
            loading={busy}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </>,
    document.body,
  );
}
