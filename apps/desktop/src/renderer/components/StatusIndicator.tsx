import type { JSX } from "react";

import type { EnvironmentPhase } from "../../shared/contracts.js";
import { cx } from "../lib/cx.js";
import { phaseLabel } from "../lib/format.js";

export interface StatusIndicatorProps {
  readonly phase: EnvironmentPhase;
  readonly className?: string;
  readonly withLabel?: boolean;
}

export function StatusIndicator({
  phase,
  className,
  withLabel = true,
}: StatusIndicatorProps): JSX.Element {
  return (
    <span
      className={cx("status", `status--${phase}`, className)}
      title={phaseLabel(phase)}
    >
      <span className="status__dot" aria-hidden="true" />
      {withLabel ? (
        phaseLabel(phase)
      ) : (
        <span className="visually-hidden">{phaseLabel(phase)}</span>
      )}
    </span>
  );
}
