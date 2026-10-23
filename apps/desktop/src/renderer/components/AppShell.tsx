import type { JSX, ReactNode } from "react";

export interface AppShellProps {
  readonly sidebar: ReactNode;
  readonly children: ReactNode;
}

/**
 * The application frame: a fixed navigation rail and one independently
 * scrolling content column. Overlays are rendered beside this shell by the
 * page so dialogs are never clipped by the scroll container.
 */
export function AppShell({ sidebar, children }: AppShellProps): JSX.Element {
  return (
    <div className="app">
      {sidebar}
      <main className="main" id="main-content">
        <div className="main__inner">{children}</div>
      </main>
    </div>
  );
}
