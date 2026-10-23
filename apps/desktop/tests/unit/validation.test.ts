import { describe, expect, it } from "vitest";

import {
  parseEnvironmentDraft,
  parseEnvironmentId,
  parseRemoveRequest,
  parseSettingsPatch,
  parseStopRequest,
  parseUpdateRequest,
} from "../../src/shared/validation.js";

function issuesOf(result: ReturnType<typeof parseEnvironmentDraft>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe("parseEnvironmentId", () => {
  it("accepts a bounded lowercase identifier", () => {
    expect(parseEnvironmentId("env-abc_123")).toEqual({
      ok: true,
      value: "env-abc_123",
    });
  });

  it.each([
    ["", "empty"],
    ["Env-1", "uppercase"],
    ["-env", "leading dash"],
    ["env/../x", "path traversal"],
    ["env id", "space"],
    ["e".repeat(65), "too long"],
    [42, "wrong type"],
    [undefined, "missing"],
  ])("rejects %s (%s)", (input: unknown, _label: string) => {
    const result = parseEnvironmentId(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("id");
    }
  });
});

describe("parseEnvironmentDraft", () => {
  it("normalises the minimal valid draft", () => {
    const result = parseEnvironmentDraft({
      name: "  工作环境  ",
      runtimePolicy: { isolation: "managed" },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        name: "工作环境",
        browser: {},
        runtimePolicy: { isolation: "managed" },
      },
    });
  });

  it("accepts every supported optional field", () => {
    const result = parseEnvironmentDraft({
      name: "Full",
      browser: { executablePath: " C:\\Chrome\\chrome.exe " },
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1.5 },
      geolocation: { latitude: 31.2, longitude: 121.5, accuracy: 25 },
      runtimePolicy: {
        isolation: "app_container",
        maxProcesses: 24,
        memoryLimitBytes: 1024 * 1024 * 1024,
      },
      launch: { additionalArguments: ["--headless=new", "--lang=zh-CN"] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.browser.executablePath).toBe(
        "C:\\Chrome\\chrome.exe",
      );
      expect(result.value.viewport?.deviceScaleFactor).toBe(1.5);
      expect(result.value.launch?.additionalArguments).toEqual([
        "--headless=new",
        "--lang=zh-CN",
      ]);
    }
  });

  it.each([
    [undefined, "draft"],
    [[], "draft"],
    [null, "draft"],
  ])("rejects non-object %s", (input, path) => {
    const result = parseEnvironmentDraft(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe(path);
    }
  });

  it("reports unknown top-level and nested fields", () => {
    expect(
      issuesOf(
        parseEnvironmentDraft({
          name: "x",
          runtimePolicy: { isolation: "managed", extra: true },
          extra: true,
          browser: { profile: "x" },
          viewport: { width: 800, height: 600, scale: 2 },
          geolocation: { latitude: 1, longitude: 1, altitude: 3 },
          launch: { additionalArguments: [], cwd: "x" },
        }),
      ),
    ).toEqual([
      "extra",
      "browser.profile",
      "viewport.scale",
      "geolocation.altitude",
      "runtimePolicy.extra",
      "launch.cwd",
    ]);
  });

  it.each([
    [undefined, "required"],
    ["", "required"],
    ["   ", "required"],
    ["x".repeat(129), "invalid_value"],
    ["bad\u0000name", "invalid_value"],
    [42, "required"],
  ])("rejects invalid name %s", (name, code) => {
    const result = parseEnvironmentDraft({
      name,
      runtimePolicy: { isolation: "managed" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.find((issue) => issue.path === "name")?.code).toBe(
        code,
      );
    }
  });

  it.each([
    [{ executablePath: "" }, "browser.executablePath", "invalid_type"],
    [{ executablePath: 3 }, "browser.executablePath", "invalid_type"],
    [
      { executablePath: "x".repeat(4097) },
      "browser.executablePath",
      "invalid_value",
    ],
    [
      { executablePath: "bad\npath" },
      "browser.executablePath",
      "invalid_value",
    ],
    ["C:\\chrome.exe", "browser", "invalid_type"],
  ])("rejects invalid browser %j", (browser, path, code) => {
    const result = parseEnvironmentDraft({
      name: "x",
      browser,
      runtimePolicy: { isolation: "managed" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.find((issue) => issue.path === path)?.code).toBe(
        code,
      );
    }
  });

  it.each([
    ["Mars/Olympus", "invalid_value"],
    ["", "invalid_type"],
    [12, "invalid_type"],
    ["x".repeat(129), "invalid_value"],
  ])("rejects timezone %s", (timezone, code) => {
    const result = parseEnvironmentDraft({
      name: "x",
      timezone,
      runtimePolicy: { isolation: "managed" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(code);
    }
  });

  it.each([
    ["not_a_locale", "invalid_value"],
    ["zh-CN,en-US", "invalid_value"],
    ["", "invalid_type"],
  ])("rejects locale %s", (locale, code) => {
    const result = parseEnvironmentDraft({
      name: "x",
      locale,
      runtimePolicy: { isolation: "managed" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(code);
    }
  });

  it("rejects malformed viewport values", () => {
    const result = parseEnvironmentDraft({
      name: "x",
      viewport: {
        width: 100,
        height: 10_000,
        deviceScaleFactor: 9,
      },
      runtimePolicy: { isolation: "managed" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual([
        "viewport.width",
        "viewport.height",
        "viewport.deviceScaleFactor",
      ]);
    }
  });

  it("rejects a non-object viewport", () => {
    const result = parseEnvironmentDraft({
      name: "x",
      viewport: "1440x900",
      runtimePolicy: { isolation: "managed" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("viewport");
    }
  });

  it.each([
    [0.49, true],
    [4.01, true],
    [Number.NaN, true],
    [0.5, false],
    [4, false],
  ])("checks device scale %s", (deviceScaleFactor, invalid) => {
    const result = parseEnvironmentDraft({
      name: "x",
      viewport: { width: 800, height: 600, deviceScaleFactor },
      runtimePolicy: { isolation: "managed" },
    });
    expect(!result.ok).toBe(invalid);
  });

  it("rejects invalid geolocation", () => {
    const result = parseEnvironmentDraft({
      name: "x",
      geolocation: { latitude: 91, longitude: -181, accuracy: -1 },
      runtimePolicy: { isolation: "managed" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual([
        "geolocation.latitude",
        "geolocation.longitude",
        "geolocation.accuracy",
      ]);
    }
  });

  it("rejects non-object geolocation", () => {
    const result = parseEnvironmentDraft({
      name: "x",
      geolocation: [],
      runtimePolicy: { isolation: "managed" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("geolocation");
    }
  });

  it("requires a runtime policy", () => {
    const result = parseEnvironmentDraft({ name: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual([
        {
          path: "runtimePolicy",
          code: "required",
          message: "runtimePolicy is required",
        },
      ]);
    }
  });

  it("rejects malformed runtime policies", () => {
    const result = parseEnvironmentDraft({
      name: "x",
      runtimePolicy: {
        isolation: "container",
        maxProcesses: 0,
        memoryLimitBytes: 1,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toMatchObject({
        path: "runtimePolicy.isolation",
        code: "invalid_value",
      });
    }
  });

  it("rejects non-object policies", () => {
    const result = parseEnvironmentDraft({ name: "x", runtimePolicy: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("runtimePolicy");
    }
  });

  it.each([
    [{ maxProcesses: 513 }, "runtimePolicy.maxProcesses"],
    [{ memoryLimitBytes: 1024 }, "runtimePolicy.memoryLimitBytes"],
    [{ maxProcesses: 1.5 }, "runtimePolicy.maxProcesses"],
  ])("rejects invalid policy bounds %j", (policy, path) => {
    const result = parseEnvironmentDraft({
      name: "x",
      runtimePolicy: { isolation: "managed", ...policy },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe(path);
    }
  });

  it("rejects malformed launch argument lists", () => {
    const result = parseEnvironmentDraft({
      name: "x",
      runtimePolicy: { isolation: "managed" },
      launch: {
        additionalArguments: [
          "no-dashes",
          "",
          "x".repeat(513),
          "bad\u0007arg",
          "--ok",
          "--ok",
          4,
          ...Array.from({ length: 20 }, (_, index) => `--arg-${String(index)}`),
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === "duplicate")).toBe(
        true,
      );
      expect(result.issues.some((issue) => issue.code === "invalid_type")).toBe(
        true,
      );
    }
  });

  it("rejects too many launch arguments", () => {
    const result = parseEnvironmentDraft({
      name: "x",
      runtimePolicy: { isolation: "managed" },
      launch: {
        additionalArguments: Array.from(
          { length: 33 },
          (_, index) => `--arg-${String(index)}`,
        ),
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe("launch.additionalArguments");
    }
  });

  it("rejects non-array launch arguments and non-object launch", () => {
    for (const launch of [{ additionalArguments: "--x" }, "x"]) {
      const result = parseEnvironmentDraft({
        name: "x",
        runtimePolicy: { isolation: "managed" },
        launch,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("accepts an empty additional-argument list", () => {
    const result = parseEnvironmentDraft({
      name: "x",
      runtimePolicy: { isolation: "managed" },
      launch: { additionalArguments: [] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.launch).toEqual({});
    }
  });
});

describe("parseUpdateRequest", () => {
  it("accepts a complete request", () => {
    const result = parseUpdateRequest({
      id: "env-1",
      draft: { name: "x", runtimePolicy: { isolation: "managed" } },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object request", () => {
    expect(parseUpdateRequest("env").ok).toBe(false);
  });

  it("combines unknown fields, id and draft issues", () => {
    const result = parseUpdateRequest({ id: "BAD", draft: {}, extra: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.map((issue) => issue.path);
      expect(paths).toContain("extra");
      expect(paths).toContain("id");
      expect(paths).toContain("name");
    }
  });
});

describe("parseStopRequest", () => {
  it("defaults to graceful", () => {
    expect(parseStopRequest(undefined)).toEqual({
      ok: true,
      value: { force: false },
    });
    expect(parseStopRequest({})).toEqual({
      ok: true,
      value: { force: false },
    });
  });

  it("accepts force", () => {
    expect(parseStopRequest({ force: true })).toEqual({
      ok: true,
      value: { force: true },
    });
  });

  it.each([
    ["x", "options"],
    [{ force: "yes" }, "options.force"],
    [{ mode: "force" }, "options.mode"],
  ])("rejects %j", (input, path) => {
    const result = parseStopRequest(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe(path);
    }
  });
});

describe("parseRemoveRequest", () => {
  it("defaults to keeping data", () => {
    expect(parseRemoveRequest(undefined)).toEqual({
      ok: true,
      value: { deleteData: false },
    });
  });

  it("accepts deleteData", () => {
    expect(parseRemoveRequest({ deleteData: true })).toEqual({
      ok: true,
      value: { deleteData: true },
    });
  });

  it.each([
    [null, "options"],
    [{ deleteData: 1 }, "options.deleteData"],
    [{ force: true }, "options.force"],
  ])("rejects %j", (input, path) => {
    const result = parseRemoveRequest(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe(path);
    }
  });
});

describe("parseSettingsPatch", () => {
  it("accepts partial settings", () => {
    expect(parseSettingsPatch({ theme: "light" })).toEqual({
      ok: true,
      value: { theme: "light" },
    });
    expect(
      parseSettingsPatch({ defaultBrowserPath: " C:\\Chrome\\chrome.exe " }),
    ).toEqual({
      ok: true,
      value: { defaultBrowserPath: "C:\\Chrome\\chrome.exe" },
    });
  });

  it("preserves an explicit undefined browser path", () => {
    const result = parseSettingsPatch({ defaultBrowserPath: undefined });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("defaultBrowserPath" in result.value).toBe(true);
      expect(result.value.defaultBrowserPath).toBeUndefined();
    }
  });

  it.each([
    [null, "settings"],
    [{ theme: "blue" }, "theme"],
    [{ theme: 1 }, "theme"],
    [{ defaultBrowserPath: "" }, "defaultBrowserPath"],
    [{ defaultBrowserPath: "x".repeat(4097) }, "defaultBrowserPath"],
    [{ defaultBrowserPath: "bad\u0001path" }, "defaultBrowserPath"],
    [{ defaultBrowserPath: 2 }, "defaultBrowserPath"],
    [{ volume: 4 }, "volume"],
  ])("rejects %j", (input, path) => {
    const result = parseSettingsPatch(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe(path);
    }
  });
});
