import type { JSX } from "react";

export function EnvironmentSkeleton(): JSX.Element {
  return (
    <div
      className="skeleton-list"
      aria-busy="true"
      aria-label="正在加载环境列表"
    >
      {[0, 1, 2].map((index) => (
        <div className="skeleton-row" key={index}>
          <div style={{ width: 220 }}>
            <div className="skeleton skeleton--title" />
            <div className="skeleton skeleton--meta" style={{ marginTop: 8 }} />
          </div>
          <div className="skeleton skeleton--grow" />
          <div className="skeleton skeleton--meta" />
          <div className="skeleton skeleton--action" />
        </div>
      ))}
    </div>
  );
}

export function PageLoading({
  label,
}: {
  readonly label: string;
}): JSX.Element {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p
        style={{ marginTop: 12, color: "var(--text-secondary)", fontSize: 12 }}
      >
        {label}
      </p>
    </div>
  );
}
