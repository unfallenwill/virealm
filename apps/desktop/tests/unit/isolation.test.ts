import { describe, expect, it } from "vitest";

import {
  BROWSER_COMPATIBLE_ISOLATION,
  browserIncompatibleDetail,
  browserIncompatibleIsolation,
  browserIncompatibleReason,
  isBrowserCompatibleIsolation,
  isolationModeLabel,
  supportsResourceLimits,
} from "../../src/shared/isolation.js";

describe("browser-compatible isolation", () => {
  it("offers the managed mode to Chrome", () => {
    expect(BROWSER_COMPATIBLE_ISOLATION).toBe("managed");
    expect(isBrowserCompatibleIsolation("managed")).toBe(true);
  });

  it.each(["restricted", "app_container"] as const)(
    "refuses %s for a Chrome environment",
    (mode) => {
      expect(browserIncompatibleIsolation().has(mode)).toBe(true);
      expect(isBrowserCompatibleIsolation(mode)).toBe(false);
    },
  );

  it("explains the Windows limitation with the evidence behind it", () => {
    expect(browserIncompatibleReason("win32")).toContain("Chrome");
    expect(browserIncompatibleReason("win32")).toContain("Job Object");
    expect(browserIncompatibleDetail("win32")).toContain("STATUS_BREAKPOINT");
    expect(browserIncompatibleDetail("win32")).toContain("Chrome 156");
  });

  it("explains the macOS limitation without Windows evidence", () => {
    expect(browserIncompatibleReason("darwin")).toContain("进程组管理");
    expect(browserIncompatibleReason("darwin")).toContain("Windows 专属");
    expect(browserIncompatibleDetail("macos")).toContain("POSIX 进程组");
    expect(browserIncompatibleDetail("macos")).toContain("沙箱");
  });

  it("labels every mode for both platforms", () => {
    expect(isolationModeLabel("managed", "win32")).toBe("Job Object 管理");
    expect(isolationModeLabel("managed", "darwin")).toBe("进程组管理");
    expect(isolationModeLabel("managed", "macos")).toBe("进程组管理");
    expect(isolationModeLabel("restricted", "darwin")).toBe("受限令牌");
    expect(isolationModeLabel("app_container", "darwin")).toBe("AppContainer");
  });

  it("disables per-tree limits only on macOS", () => {
    expect(supportsResourceLimits("win32")).toBe(true);
    expect(supportsResourceLimits("darwin")).toBe(false);
    expect(supportsResourceLimits("macos")).toBe(false);
  });
});
