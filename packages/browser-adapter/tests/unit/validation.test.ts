import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ChromeDiscoveryPort } from "../../src/application/ports.js";
import {
  validateEnvironment,
  type ValidationContext,
} from "../../src/environment/validation.js";
import type { DiscoveredBrowser } from "../../src/domain/environment.js";
import {
  FakeDiscovery,
  TEST_CHROME,
  TEST_CHROME_VERSION,
  makeConfig,
} from "./helpers/fakes.js";

const dataRoot = path.join(tmpdir(), "virealm-validation-root");
const localAppData = path.join(tmpdir(), "virealm-validation-local");

function context(
  discovery: ChromeDiscoveryPort = new FakeDiscovery(),
  root = dataRoot,
): ValidationContext {
  return { dataRoot: root, discovery, localAppData };
}

function issuesOf(input: unknown, ctx = context()): string[] {
  const result = validateEnvironment(input, ctx);
  expect(result.valid).toBe(false);
  expect(result.resolved).toBeUndefined();
  return result.issues.map((issue) => `${issue.path}:${issue.code}`);
}

describe("validateEnvironment", () => {
  it("resolves a complete configuration", () => {
    const result = validateEnvironment(
      makeConfig({
        timezone: "Asia/Singapore",
        locale: "en-US",
        viewport: { width: 1_366, height: 768, deviceScaleFactor: 1 },
      }),
      context(),
    );

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.resolved?.browser.executablePath).toBe(TEST_CHROME);
    expect(result.resolved?.canonicalLocale).toBe("en-US");
    expect(result.resolved?.profile.userDataDir).toBe(
      path.join(dataRoot, "environments", "env_a", "chrome-data"),
    );
  });

  it("canonicalises locale casing", () => {
    const result = validateEnvironment(
      makeConfig({ locale: "EN-gb" }),
      context(),
    );
    expect(result.resolved?.canonicalLocale).toBe("en-GB");
  });

  it("accepts an override profile inside the root", () => {
    const override = path.join(dataRoot, "custom-profile");
    const result = validateEnvironment(
      makeConfig({
        browser: {
          executablePath: TEST_CHROME,
          version: TEST_CHROME_VERSION,
          userDataDir: override,
        },
      }),
      context(),
    );
    expect(result.resolved?.profile.userDataDir).toBe(override);
  });

  it("rejects non-object input", () => {
    expect(validateEnvironment("config", context())).toEqual({
      valid: false,
      issues: [
        {
          path: "/",
          code: "invalid_type",
          message: "environment configuration must be an object",
        },
      ],
      resolved: undefined,
    });
  });

  it("reports unknown fields at every level", () => {
    const config = {
      ...makeConfig(),
      unexpected: true,
      browser: { executablePath: TEST_CHROME, surprise: 1 },
      viewport: { width: 800, height: 600, extra: 1 },
      runtimePolicy: { isolation: "managed", extra: 1 },
      persistence: { mode: "persistent", extra: 1 },
      launch: { initialUrls: [], extra: 1 },
    };
    const issues = issuesOf(config);
    expect(issues).toEqual(
      expect.arrayContaining([
        "unexpected:unknown_field",
        "browser.surprise:unknown_field",
        "viewport.extra:unknown_field",
        "runtimePolicy.extra:unknown_field",
        "persistence.extra:unknown_field",
        "launch.extra:unknown_field",
      ]),
    );
  });

  it("requires id, name, browser, runtime policy and persistence", () => {
    const issues = issuesOf({});
    expect(issues).toEqual(
      expect.arrayContaining([
        "id:required",
        "name:required",
        "browser:required",
        "runtimePolicy:required",
        "persistence:required",
      ]),
    );
  });

  it("rejects an unsafe environment id", () => {
    expect(issuesOf(makeConfig({ id: "Env A/../x" }))).toContain(
      "id:invalid_value",
    );
    expect(issuesOf(makeConfig({ id: "" }))).toContain("id:required");
    expect(issuesOf({ ...makeConfig(), id: 5 })).toContain("id:required");
  });

  it("rejects an empty, oversized or control-character name", () => {
    expect(issuesOf(makeConfig({ name: "   " }))).toContain("name:required");
    expect(issuesOf(makeConfig({ name: "x".repeat(129) }))).toContain(
      "name:invalid_value",
    );
    expect(issuesOf(makeConfig({ name: "bad\u0001name" }))).toContain(
      "name:invalid_value",
    );
    expect(issuesOf({ ...makeConfig(), name: 5 })).toContain("name:required");
  });

  it("rejects a malformed browser block", () => {
    expect(issuesOf({ ...makeConfig(), browser: "chrome" })).toContain(
      "browser:invalid_type",
    );
    expect(
      issuesOf(
        makeConfig({
          browser: { executablePath: "chrome.exe" },
        }),
      ),
    ).toContain("browser.executablePath:invalid_path");
    expect(
      issuesOf({
        ...makeConfig(),
        browser: { executablePath: TEST_CHROME, version: 156 },
      }),
    ).toContain("browser.version:invalid_type");
  });

  it("rejects an invalid isolation mode and limits", () => {
    const invalidIsolation = {
      ...makeConfig(),
      runtimePolicy: { isolation: "sandbox" },
    };
    expect(issuesOf(invalidIsolation)).toContain(
      "runtimePolicy.isolation:invalid_value",
    );
    expect(
      issuesOf(
        makeConfig({
          runtimePolicy: { isolation: "managed", maxProcesses: 0 },
        }),
      ),
    ).toContain("runtimePolicy.maxProcesses:invalid_value");
    expect(
      issuesOf(
        makeConfig({
          runtimePolicy: { isolation: "managed", memoryLimitBytes: -1 },
        }),
      ),
    ).toContain("runtimePolicy.memoryLimitBytes:invalid_value");
  });

  it("rejects an ephemeral persistence mode", () => {
    expect(
      issuesOf({
        ...makeConfig(),
        persistence: { mode: "ephemeral" },
      }),
    ).toContain("persistence.mode:unsupported");
    expect(issuesOf({ ...makeConfig(), persistence: 3 })).toContain(
      "persistence:required",
    );
  });

  it("rejects invalid locales and time zones", () => {
    expect(issuesOf(makeConfig({ locale: "not a locale!" }))).toContain(
      "locale:invalid_value",
    );
    expect(issuesOf({ ...makeConfig(), locale: 5 })).toContain(
      "locale:invalid_type",
    );
    expect(issuesOf(makeConfig({ timezone: "Mars/Olympus" }))).toContain(
      "timezone:invalid_value",
    );
    expect(issuesOf({ ...makeConfig(), timezone: "" })).toContain(
      "timezone:invalid_type",
    );
  });

  it("rejects viewport values outside the supported range", () => {
    const issues = issuesOf(
      makeConfig({
        viewport: { width: 200, height: 100, deviceScaleFactor: 9 },
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        "viewport.width:invalid_value",
        "viewport.height:invalid_value",
        "viewport.deviceScaleFactor:invalid_value",
      ]),
    );
    expect(issuesOf({ ...makeConfig(), viewport: 1 })).toContain(
      "viewport:invalid_type",
    );
  });

  it("rejects geolocation coordinates outside the legal range", () => {
    expect(
      issuesOf(
        makeConfig({
          geolocation: { latitude: 91, longitude: -181, accuracy: -1 },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "geolocation.latitude:invalid_value",
        "geolocation.longitude:invalid_value",
        "geolocation.accuracy:invalid_value",
      ]),
    );
    expect(issuesOf({ ...makeConfig(), geolocation: [] })).toContain(
      "geolocation:invalid_type",
    );
  });

  it("validates launch URLs and additional Chrome switches", () => {
    expect(
      issuesOf(
        makeConfig({
          launch: {
            initialUrls: ["file:///C:/secret", "javascript:alert(1)"],
          },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "launch.initialUrls.0:invalid_value",
        "launch.initialUrls.1:invalid_value",
      ]),
    );
    expect(
      issuesOf(
        makeConfig({
          launch: { additionalArguments: ["--no-sandbox"] },
        }),
      ),
    ).toContain("launch.additionalArguments.0:invalid_value");
    const invalidInitialUrls: unknown = {
      ...makeConfig(),
      launch: { initialUrls: "about:blank" },
    };
    expect(issuesOf(invalidInitialUrls)).toContain(
      "launch.initialUrls:invalid_type",
    );
    expect(
      issuesOf(
        makeConfig({
          launch: {
            initialUrls: Array.from({ length: 9 }, () => "about:blank"),
          },
        }),
      ),
    ).toContain("launch.initialUrls:invalid_value");
    const invalidUrlEntry: unknown = {
      ...makeConfig(),
      launch: { initialUrls: [5] },
    };
    expect(issuesOf(invalidUrlEntry)).toContain(
      "launch.initialUrls:invalid_type",
    );
    const invalidLaunch: unknown = { ...makeConfig(), launch: "yes" };
    expect(issuesOf(invalidLaunch)).toContain("launch:invalid_type");
  });

  it("refuses Chrome's default profile directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "virealm-default-profile-"));
    const homeDirectory = path.join(root, "home");
    const chromeLocalAppData = path.join(root, "local-app-data");
    const ctx: ValidationContext = {
      dataRoot: root,
      discovery: new FakeDiscovery(),
      localAppData: chromeLocalAppData,
      homeDirectory,
      platform: process.platform,
    };
    const userDataDir =
      process.platform === "win32"
        ? path.join(chromeLocalAppData, "Google", "Chrome", "User Data")
        : path.join(
            homeDirectory,
            "Library",
            "Application Support",
            "Google",
            "Chrome",
          );
    const result = validateEnvironment(
      makeConfig({
        browser: { executablePath: TEST_CHROME, userDataDir },
      }),
      ctx,
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain(
      "Chrome's default profile directory cannot be used for remote debugging",
    );
  });

  it("reports a missing explicit Chrome executable", () => {
    const issues = issuesOf(
      makeConfig({
        browser: {
          executablePath: path.join(
            tmpdir(),
            "virealm-missing-chrome",
            "chrome.exe",
          ),
        },
      }),
    );
    expect(issues).toContain("browser.executablePath:chrome_not_found");
  });

  it("reports when no Chrome installation exists at all", () => {
    const issues = issuesOf(
      makeConfig({ browser: {} }),
      context(new FakeDiscovery([])),
    );
    expect(issues).toContain("browser.executablePath:chrome_not_found");
  });

  it("reports an expected version mismatch", () => {
    const issues = issuesOf(
      makeConfig({
        browser: { executablePath: TEST_CHROME, version: "1.0.0.0" },
      }),
    );
    expect(issues).toContain("browser.version:chrome_incompatible");
  });

  it("reports an undeterminable version when one is required", () => {
    const unknown: DiscoveredBrowser[] = [
      {
        executablePath: TEST_CHROME,
        version: "unknown",
        source: "test",
      },
    ];
    const issues = issuesOf(
      makeConfig({
        browser: { executablePath: TEST_CHROME, version: "unknown" },
      }),
      context(new FakeDiscovery(unknown)),
    );
    expect(issues).toContain("browser.version:chrome_incompatible");
  });

  it("rejects a relative Virealm data root", () => {
    expect(
      issuesOf(makeConfig(), context(new FakeDiscovery(), "relative-root")),
    ).toContain("dataRoot:invalid_path");
  });

  it("rejects a custom profile outside the data root", () => {
    expect(
      issuesOf(
        makeConfig({
          browser: {
            executablePath: TEST_CHROME,
            userDataDir: path.join(tmpdir(), "outside-virealm-root"),
          },
        }),
      ),
    ).toContain("browser.userDataDir:invalid_path");
  });
});
