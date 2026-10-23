import { describe, expect, it } from "vitest";

import {
  BROWSER_COMPATIBLE_ISOLATION,
  BROWSER_INCOMPATIBLE_DETAIL,
  BROWSER_INCOMPATIBLE_ISOLATION,
  BROWSER_INCOMPATIBLE_REASON,
  isBrowserCompatibleIsolation,
  isolationModeLabel,
} from "../../src/shared/isolation.js";

describe("browser-compatible isolation", () => {
  it("offers the managed Job Object mode to Chrome", () => {
    expect(BROWSER_COMPATIBLE_ISOLATION).toBe("managed");
    expect(isBrowserCompatibleIsolation("managed")).toBe(true);
  });

  it.each(["restricted", "app_container"] as const)(
    "refuses %s for a Chrome environment",
    (mode) => {
      expect(BROWSER_INCOMPATIBLE_ISOLATION.has(mode)).toBe(true);
      expect(isBrowserCompatibleIsolation(mode)).toBe(false);
    },
  );

  it("explains the limitation with the evidence behind it", () => {
    expect(BROWSER_INCOMPATIBLE_REASON).toContain("Chrome");
    expect(BROWSER_INCOMPATIBLE_REASON).toContain("Job Object");
    expect(BROWSER_INCOMPATIBLE_DETAIL).toContain("STATUS_BREAKPOINT");
    expect(BROWSER_INCOMPATIBLE_DETAIL).toContain("Chrome 156");
  });

  it("labels every mode", () => {
    expect(isolationModeLabel("managed")).toBe("Job Object 管理");
    expect(isolationModeLabel("restricted")).toBe("受限令牌");
    expect(isolationModeLabel("app_container")).toBe("AppContainer");
  });
});
