import { useEffect, useRef, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { IconButton } from "./Button.js";

export interface DrawerProps {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly eyebrow?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onRequestClose: () => void;
  readonly wide?: boolean;
  readonly labelledBy?: string;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Side panel with a focus trap. Escape and the backdrop call
 * `onRequestClose`, which may ask about unsaved changes first.
 */
export function Drawer({
  title,
  subtitle,
  eyebrow,
  children,
  footer,
  onRequestClose,
  wide = false,
  labelledBy = "drawer-title",
}: DrawerProps): JSX.Element {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const panel = panelRef.current;
    const initial =
      panel?.querySelector<HTMLElement>("[data-autofocus]") ??
      panel?.querySelector<HTMLElement>(
        "input, select, textarea, button:not(.icon-btn)",
      ) ??
      panel?.querySelector<HTMLElement>("button");
    initial?.focus();

    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || panel === null) {
        return;
      }
      const focusable = [
        ...panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
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
      <div
        className="overlay"
        aria-hidden="true"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            onRequestClose();
          }
        }}
      />
      <aside
        ref={panelRef}
        className={wide ? "drawer drawer--wide" : "drawer"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        <header className="drawer__header">
          <div className="drawer__heading">
            {eyebrow === undefined ? null : (
              <div className="drawer__eyebrow">{eyebrow}</div>
            )}
            <h1 className="drawer__title" id={labelledBy}>
              {title}
            </h1>
            {subtitle === undefined ? null : (
              <div className="drawer__subtitle">{subtitle}</div>
            )}
          </div>
          <IconButton icon="close" label="关闭" onClick={onRequestClose} />
        </header>
        <div className="drawer__body">{children}</div>
        {footer === undefined ? null : (
          <footer className="drawer__footer">{footer}</footer>
        )}
      </aside>
    </>,
    document.body,
  );
}
