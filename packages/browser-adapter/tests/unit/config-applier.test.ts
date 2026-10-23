import path from "node:path";

import { describe, expect, it } from "vitest";

import { EnvironmentConfigApplier } from "../../src/environment/config-applier.js";
import type {
  BrowserEnvironmentConfig,
  ResolvedBrowserEnvironment,
} from "../../src/domain/environment.js";
import {
  FakeSession,
  makeConfig,
  requireValue,
  TEST_CHROME,
  TEST_CHROME_VERSION,
} from "./helpers/fakes.js";

const now = (): number => 1_700_000_000_000;

function resolved(
  config: BrowserEnvironmentConfig,
): ResolvedBrowserEnvironment {
  return {
    config,
    browser: {
      executablePath: TEST_CHROME,
      version: TEST_CHROME_VERSION,
      source: "test",
    },
    profile: {
      environmentRoot: path.join("C:\\data", "environments", config.id),
      userDataDir: path.join(
        "C:\\data",
        "environments",
        config.id,
        "chrome-data",
      ),
    },
    canonicalLocale:
      config.locale === undefined
        ? undefined
        : Intl.getCanonicalLocales(config.locale)[0],
    viewport: config.viewport,
    geolocation: config.geolocation,
  };
}

const fullConfig = makeConfig({
  timezone: "Asia/Singapore",
  locale: "en-US",
  viewport: { width: 1_366, height: 768, deviceScaleFactor: 2 },
  geolocation: { latitude: 1.3521, longitude: 103.8198, accuracy: 20 },
});

describe("EnvironmentConfigApplier.apply", () => {
  it("applies every declared field to every page", async () => {
    const session = new FakeSession(2);
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.apply(resolved(fullConfig));

    expect(report.environmentId).toBe("env_a");
    expect(report.pages).toHaveLength(2);
    expect(report.fields.map((field) => field.field)).toEqual([
      "timezone",
      "locale",
      "acceptLanguage",
      "viewport",
      "deviceScaleFactor",
      "geolocation",
    ]);
    expect(report.fields.every((field) => field.status === "applied")).toBe(
      true,
    );

    const firstPage = requireValue(session.pagesList[0]);
    const methods = requireValue(firstPage.cdpSessions[0]).sent.map(
      (entry) => entry.method,
    );
    expect(methods).toEqual(
      expect.arrayContaining([
        "Emulation.setTimezoneOverride",
        "Emulation.setLocaleOverride",
        "Network.setUserAgentOverride",
        "Emulation.setDeviceMetricsOverride",
        "Emulation.setGeolocationOverride",
      ]),
    );
    expect(session.commands).toHaveLength(2);
    expect(session.commands).toEqual(
      expect.arrayContaining([
        {
          method: "Browser.grantPermissions",
          params: { permissions: ["geolocation"] },
        },
      ]),
    );
    expect(firstPage.timezone).toBe("Asia/Singapore");
    expect(firstPage.language).toBe("en-US");
    expect(firstPage.viewport.width).toBe(1_366);
    expect(firstPage.pixelRatio).toBe(2);
  });

  it("leaves undeclared fields untouched", async () => {
    const session = new FakeSession(1);
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.apply(resolved(makeConfig()));
    expect(report.fields).toEqual([]);
    expect(report.pages).toHaveLength(1);
    expect(report.pages[0]?.fields).toEqual([]);
  });

  it("reports not_verified when no live page exists", async () => {
    const session = new FakeSession(0);
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.apply(resolved(fullConfig));
    expect(report.pages).toEqual([]);
    expect(
      report.fields.every((field) => field.status === "not_verified"),
    ).toBe(true);
    expect(report.fields[0]?.reason).toContain("no live page");
  });

  it("records a failed CDP command with its method in the report", async () => {
    const session = new FakeSession(1);
    const page = requireValue(session.pagesList[0]);
    page.failMethods = new Set(["Emulation.setTimezoneOverride"]);
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.apply(resolved(fullConfig));

    const timezone = report.fields.find((field) => field.field === "timezone");
    expect(timezone?.status).toBe("failed");
    expect(timezone?.capability).toBe("Emulation.setTimezoneOverride");
    expect(timezone?.reason).toContain("forced");
  });

  it("records a geolocation setup failure", async () => {
    const session = new FakeSession(1);
    session.browserCommandError = new Error("permission API unavailable");
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.apply(resolved(fullConfig));
    const geolocation = report.fields.find(
      (field) => field.field === "geolocation",
    );
    expect(geolocation?.status).toBe("failed");
    expect(geolocation?.reason).toContain("permission API unavailable");
  });

  it("aggregates the worst status across pages", async () => {
    const session = new FakeSession(2);
    requireValue(session.pagesList[1]).failMethods = new Set([
      "Emulation.setTimezoneOverride",
    ]);
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.apply(resolved(fullConfig));
    const timezone = report.fields.find((field) => field.field === "timezone");
    expect(timezone?.status).toBe("failed");
  });
});

describe("EnvironmentConfigApplier.verify", () => {
  it("verifies timezone, locale and viewport by reading them back", async () => {
    const session = new FakeSession(1);
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.verify(resolved(fullConfig), {});

    for (const field of [
      "timezone",
      "locale",
      "viewport",
      "deviceScaleFactor",
    ]) {
      const result = report.fields.find((entry) => entry.field === field);
      expect(result?.status).toBe("verified");
      expect(result?.requested).toBeDefined();
      expect(result?.observed).toBeDefined();
    }
  });

  it("uses the language itself when no region subtag is present", async () => {
    const session = new FakeSession(1);
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.apply(resolved(makeConfig({ locale: "en" })));
    const header = report.fields.find(
      (field) => field.field === "acceptLanguage",
    );
    expect(header?.requested).toBe("en");
  });

  it("reports acceptLanguage as not_verified without a probe URL", async () => {
    const session = new FakeSession(1);
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.verify(resolved(fullConfig), {});
    const header = report.fields.find(
      (field) => field.field === "acceptLanguage",
    );
    expect(header?.status).toBe("not_verified");
    expect(header?.reason).toContain("no network probe URL");
  });

  it("verifies the HTTP Accept-Language header through the probe", async () => {
    const session = new FakeSession(1);
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.verify(resolved(fullConfig), {
      networkProbeUrl: "http://127.0.0.1:9999/headers",
    });
    const header = report.fields.find(
      (field) => field.field === "acceptLanguage",
    );
    expect(header?.status).toBe("verified");
    expect(header?.observed).toBe("en-US,en");
  });

  it("reports a probe without the expected header field", async () => {
    const session = new FakeSession(1);
    const page = requireValue(session.pagesList[0]);
    const applier = new EnvironmentConfigApplier(session, now);
    page.reflectAcceptLanguage = false;
    page.probeResult = { somethingElse: true };
    const report = await applier.verify(resolved(fullConfig), {
      networkProbeUrl: "http://127.0.0.1:9999/headers",
    });
    const header = report.fields.find(
      (field) => field.field === "acceptLanguage",
    );
    expect(header?.status).toBe("not_verified");
    expect(header?.reason).toContain("did not return");
  });

  it("reports a failed network probe as not_verified", async () => {
    const session = new FakeSession(1);
    const page = requireValue(session.pagesList[0]);
    page.reflectAcceptLanguage = false;
    page.probeResult = new Error("probe offline");
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.verify(resolved(fullConfig), {
      networkProbeUrl: "http://127.0.0.1:9999/headers",
    });
    const header = report.fields.find(
      (field) => field.field === "acceptLanguage",
    );
    expect(header?.status).toBe("not_verified");
    expect(header?.reason).toContain("probe offline");
  });

  it("reports a timezone mismatch as failed", async () => {
    const session = new FakeSession(1);
    const page = requireValue(session.pagesList[0]);
    page.reflectTimezone = false;
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.verify(resolved(fullConfig), {});
    const timezone = report.fields.find((field) => field.field === "timezone");
    expect(timezone?.status).toBe("failed");
    expect(timezone?.observed).toBe("UTC");
  });

  it("reports a locale mismatch as failed", async () => {
    const session = new FakeSession(1);
    const page = requireValue(session.pagesList[0]);
    page.reflectLocale = false;
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.verify(
      resolved(makeConfig({ locale: "fr-FR" })),
      {},
    );
    const locale = report.fields.find((field) => field.field === "locale");
    expect(locale?.status).toBe("failed");
  });

  it("reports a viewport mismatch as failed", async () => {
    const session = new FakeSession(1);
    const page = requireValue(session.pagesList[0]);
    page.reflectViewport = false;
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.verify(resolved(fullConfig), {});
    expect(
      report.fields.find((field) => field.field === "viewport")?.status,
    ).toBe("failed");
  });

  it("reports a device scale factor mismatch as failed", async () => {
    const session = new FakeSession(1);
    const page = requireValue(session.pagesList[0]);
    page.reflectDeviceScale = false;
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.verify(resolved(fullConfig), {});
    expect(
      report.fields.find((field) => field.field === "deviceScaleFactor")
        ?.status,
    ).toBe("failed");
  });

  it("reports not_verified when a read-back expression throws", async () => {
    const session = new FakeSession(1);
    const page = requireValue(session.pagesList[0]);
    page.evaluateError = new Error("page crashed");
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.verify(resolved(fullConfig), {});
    expect(
      report.fields.find((field) => field.field === "timezone")?.status,
    ).toBe("not_verified");
  });

  it("verifies geolocation coordinates", async () => {
    const session = new FakeSession(1);
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.verify(resolved(fullConfig), {});
    const geolocation = report.fields.find(
      (field) => field.field === "geolocation",
    );
    expect(geolocation?.status).toBe("verified");
    expect(geolocation?.observed).toMatchObject({
      latitude: 1.3521,
      longitude: 103.8198,
    });
  });

  it("reports geolocation as unsupported when the API is missing", async () => {
    const session = new FakeSession(1);
    const page = requireValue(session.pagesList[0]);
    page.reflectGeolocation = false;
    page.geolocationResult = { supported: false };
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.verify(resolved(fullConfig), {});
    const geolocation = report.fields.find(
      (field) => field.field === "geolocation",
    );
    expect(geolocation?.status).toBe("unsupported");
  });

  it("reports a permission denial as failed", async () => {
    const session = new FakeSession(1);
    const page = requireValue(session.pagesList[0]);
    page.reflectGeolocation = false;
    page.geolocationResult = {
      supported: true,
      error: "User denied Geolocation",
    };
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.verify(resolved(fullConfig), {});
    const geolocation = report.fields.find(
      (field) => field.field === "geolocation",
    );
    expect(geolocation?.status).toBe("failed");
    expect(geolocation?.reason).toContain("denied");
  });

  it("reports a geolocation timeout as not_verified", async () => {
    const session = new FakeSession(1);
    const page = requireValue(session.pagesList[0]);
    page.reflectGeolocation = false;
    page.geolocationResult = { supported: true, timedOut: true };
    const applier = new EnvironmentConfigApplier(session, now);
    const report = await applier.verify(resolved(fullConfig), {});
    const geolocation = report.fields.find(
      (field) => field.field === "geolocation",
    );
    expect(geolocation?.status).toBe("not_verified");
    expect(geolocation?.reason).toContain("did not resolve");
  });
});

describe("EnvironmentConfigApplier.dispose", () => {
  it("detaches cached CDP sessions and forgets reports", async () => {
    const session = new FakeSession(1);
    const page = requireValue(session.pagesList[0]);
    const applier = new EnvironmentConfigApplier(session, now);
    await applier.apply(resolved(fullConfig));
    const cdp = requireValue(page.cdpSessions[0]);

    await applier.dispose();
    expect(cdp.detached).toBe(true);
    expect(applier.buildReport(resolved(fullConfig)).pages).toEqual([]);

    await applier.apply(resolved(fullConfig));
    expect(page.cdpSessions).toHaveLength(2);
  });
});
