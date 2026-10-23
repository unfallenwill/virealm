import { useEffect, useRef, useState, type JSX } from "react";

import { Icon, type IconName } from "./Icon.js";

export interface MenuAction {
  readonly kind?: "item";
  readonly label: string;
  readonly icon?: IconName;
  readonly onSelect: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly reason?: string;
}

export interface MenuSeparator {
  readonly kind: "separator";
}

export type MenuEntry = MenuAction | MenuSeparator;

export interface MenuProps {
  readonly label: string;
  readonly entries: readonly MenuEntry[];
}

/**
 * Compact row menu: keyboard reachable, closes on Escape or outside click and
 * returns focus to its trigger.
 */
export function Menu({ label, entries }: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const first = rootRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([disabled])',
    );
    first?.focus();

    const onPointerDown = (event: PointerEvent): void => {
      if (
        rootRef.current !== null &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const moveFocus = (direction: 1 | -1): void => {
    const items = [
      ...(rootRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      ) ?? []),
    ];
    if (items.length === 0) {
      return;
    }
    const active = document.activeElement;
    const index = items.findIndex((item) => item === active);
    const next = items[(index + direction + items.length) % items.length];
    next?.focus();
  };

  return (
    <div className="menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <Icon name="more" size={17} />
      </button>
      {open ? (
        <div
          className="menu__popover"
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveFocus(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(-1);
            } else if (event.key === "Tab") {
              setOpen(false);
            }
          }}
        >
          {entries.map((entry, index) =>
            entry.kind === "separator" ? (
              <div className="menu__separator" key={`sep-${String(index)}`} />
            ) : (
              <button
                key={entry.label}
                type="button"
                role="menuitem"
                className={
                  entry.danger ? "menu__item menu__item--danger" : "menu__item"
                }
                disabled={entry.disabled === true}
                title={
                  entry.disabled === true
                    ? (entry.reason ?? entry.label)
                    : undefined
                }
                onClick={() => {
                  setOpen(false);
                  entry.onSelect();
                }}
              >
                {entry.icon === undefined ? null : (
                  <Icon name={entry.icon} size={14} />
                )}
                {entry.label}
                {entry.disabled === true && entry.reason !== undefined ? (
                  <span className="menu__item-reason">不可用</span>
                ) : null}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
