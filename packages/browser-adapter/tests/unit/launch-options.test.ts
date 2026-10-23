import { describe, expect, it } from "vitest";

import {
  assertSafeAdditionalArguments,
  assertSafeLaunchArguments,
  buildChromeArguments,
  unsafeArgumentReason,
} from "../../src/chrome/launch-options.js";
import {
  BrowserAdapterError,
  isBrowserAdapterError,
} from "../../src/domain/errors.js";

const USER_DATA_DIR = "C:\\VirealmData\\environments\\env_a\\chrome-data";

describe("unsafeArgumentReason", () => {
  it("accepts an ordinary Chrome switch", () => {
    expect(unsafeArgumentReason("--disable-background-timer-throttling")).toBe(
      undefined,
    );
  });

  it.each([
    ["", "empty argument"],
    ["--no-sandbox", "managed by the adapter"],
    ["--disable-web-security", "managed by the adapter"],
    ["--user-data-dir=C:\\elsewhere", "managed by the adapter"],
    ["--remote-debugging-port=9222", "managed by the adapter"],
    ["--remote-debugging-pipe", "managed by the adapter"],
    ["--load-extension=C:\\evil", "managed by the adapter"],
    ["--disable-features=IsolateOrigins", "managed by the adapter"],
    ["not-a-switch", "must be Chrome switches"],
  ])("rejects %j", (argument, expected) => {
    expect(unsafeArgumentReason(argument)).toContain(expected);
  });

  it("rejects oversized and control-character arguments", () => {
    expect(unsafeArgumentReason(`--flag=${"a".repeat(1_024)}`)).toContain(
      "1024 characters",
    );
    expect(unsafeArgumentReason("--flag=a\nb")).toContain("control character");
  });

  it("matches reserved switch names case-insensitively", () => {
    expect(unsafeArgumentReason("--NO-SANDBOX")).toContain(
      "managed by the adapter",
    );
  });
});

describe("buildChromeArguments", () => {
  it("always uses a dedicated profile, an ephemeral loopback port and argv", () => {
    const argumentsList = buildChromeArguments({
      userDataDir: USER_DATA_DIR,
      locale: undefined,
      viewport: undefined,
      initialUrls: undefined,
      additionalArguments: undefined,
    });

    expect(argumentsList).toEqual([
      `--user-data-dir=${USER_DATA_DIR}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ]);
    expect(argumentsList.some((entry) => entry.includes(";"))).toBe(false);
  });

  it("adds locale, window size, extra switches and declared URLs", () => {
    const argumentsList = buildChromeArguments({
      userDataDir: USER_DATA_DIR,
      locale: "en-GB",
      viewport: { width: 1_366, height: 768 },
      initialUrls: ["http://127.0.0.1:8080/app"],
      additionalArguments: ["--disable-background-timer-throttling"],
    });

    expect(argumentsList).toContain("--lang=en-GB");
    expect(argumentsList).toContain("--window-size=1366,768");
    expect(argumentsList).toContain("--disable-background-timer-throttling");
    expect(argumentsList.at(-1)).toBe("http://127.0.0.1:8080/app");
  });

  it("ignores an empty initial URL list by opening about:blank", () => {
    const argumentsList = buildChromeArguments({
      userDataDir: USER_DATA_DIR,
      locale: undefined,
      viewport: undefined,
      initialUrls: [],
      additionalArguments: undefined,
    });
    expect(argumentsList.at(-1)).toBe("about:blank");
  });

  it("throws on reserved switches instead of rewriting them", () => {
    expect(() =>
      buildChromeArguments({
        userDataDir: USER_DATA_DIR,
        locale: undefined,
        viewport: undefined,
        initialUrls: undefined,
        additionalArguments: ["--no-sandbox"],
      }),
    ).toThrow(BrowserAdapterError);
  });

  it("rejects more than 64 extra switches", () => {
    const additional = Array.from(
      { length: 65 },
      (_, index) => `--extra-${String(index)}`,
    );
    expect(() =>
      buildChromeArguments({
        userDataDir: USER_DATA_DIR,
        locale: undefined,
        viewport: undefined,
        initialUrls: undefined,
        additionalArguments: additional,
      }),
    ).toThrow(/at most 64/);
  });
});

describe("assertSafeAdditionalArguments", () => {
  it("accepts safe switches", () => {
    expect(() => {
      assertSafeAdditionalArguments(["--disable-sync"]);
    }).not.toThrow();
  });

  it("rejects a reserved switch and reports a typed error", () => {
    try {
      assertSafeAdditionalArguments(["--disable-web-security"]);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(isBrowserAdapterError(error)).toBe(true);
      if (isBrowserAdapterError(error)) {
        expect(error.code).toBe("invalid_configuration");
        expect(error.details?.path).toBe("launch.additionalArguments");
      }
    }
  });
});

describe("assertSafeLaunchArguments", () => {
  it("accepts the generated launch", () => {
    const argumentsList = buildChromeArguments({
      userDataDir: USER_DATA_DIR,
      locale: undefined,
      viewport: undefined,
      initialUrls: undefined,
      additionalArguments: undefined,
    });
    expect(() => {
      assertSafeLaunchArguments(argumentsList);
    }).not.toThrow();
  });

  it.each([
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-web-security=true",
  ])("refuses %s as defence in depth", (argument) => {
    expect(() => {
      assertSafeLaunchArguments([argument]);
    }).toThrow(BrowserAdapterError);
  });
});
