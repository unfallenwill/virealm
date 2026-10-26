import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  bundleRootOf,
  chromeInstallRoot,
  isPathInside,
  pathKey,
  samePath,
} from "../../src/platform/paths.js";

describe("pathKey", () => {
  it("lowercases Windows keys only", () => {
    expect(pathKey("C:\\Chrome\\Chrome.exe", "win32")).toBe(
      path.win32.resolve("c:\\chrome\\chrome.exe"),
    );
    expect(pathKey("/Applications/Google Chrome.app", "darwin")).toBe(
      "/Applications/Google Chrome.app",
    );
  });

  it("ignores a trailing separator", () => {
    expect(pathKey("/tmp/data/", "darwin")).toBe("/tmp/data");
  });
});

describe("samePath", () => {
  it("compares with the requested platform's semantics", () => {
    expect(samePath("C:\\Root\\A", "c:\\root\\a", "win32")).toBe(true);
    expect(samePath("/Users/A", "/Users/a", "darwin")).toBe(false);
  });
});

describe("isPathInside", () => {
  it("rejects siblings and parent traversal", () => {
    expect(isPathInside("/data", "/data/environments", "darwin")).toBe(true);
    expect(isPathInside("/data", "/database", "darwin")).toBe(false);
    expect(isPathInside("/data/env", "/data", "darwin")).toBe(false);
  });
});

describe("chromeInstallRoot", () => {
  it("uses the executable directory on Windows", () => {
    expect(
      chromeInstallRoot(
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "win32",
      ),
    ).toBe("C:\\Program Files\\Google\\Chrome\\Application");
  });

  it("uses the .app bundle on macOS", () => {
    expect(
      chromeInstallRoot(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "darwin",
      ),
    ).toBe("/Applications/Google Chrome.app");
  });

  it("falls back to the containing directory outside a bundle", () => {
    expect(chromeInstallRoot("/opt/chrome/chrome", "darwin")).toBe(
      path.posix.dirname("/opt/chrome/chrome"),
    );
  });

  it("finds the outermost .app component", () => {
    expect(
      bundleRootOf(
        "/Applications/Outer.app/Inner.app/Contents/MacOS/Chrome",
        "darwin",
      ),
    ).toBe("/Applications/Outer.app");
    expect(bundleRootOf("/opt/chrome/chrome", "darwin")).toBeUndefined();
  });
});
