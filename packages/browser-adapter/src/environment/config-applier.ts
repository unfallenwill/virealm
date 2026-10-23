import type {
  BrowserPagePort,
  BrowserSessionPort,
  CdpSessionPort,
} from "../application/ports.js";
import type {
  ConfigField,
  ConfigFieldResult,
  ConfigFieldValue,
  ConfigFieldStatus,
  EnvironmentConfigReport,
  PageConfigReport,
} from "../domain/status.js";
import type {
  BrowserEnvironmentConfig,
  GeolocationConfig,
  ResolvedBrowserEnvironment,
  ViewportConfig,
} from "../domain/environment.js";
import type { ApplyConfigOptions } from "../domain/status.js";

interface ViewportObservation {
  readonly width: number;
  readonly height: number;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly devicePixelRatio: number;
}

interface LocaleObservation {
  readonly language: string;
  readonly languages: string;
}

interface GeolocationObservation {
  readonly supported: boolean;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly accuracy?: number;
  readonly error?: string;
  readonly timedOut?: boolean;
}

/**
 * Applies declared configuration over CDP and reads it back.
 *
 * Emulation is not an OS-level change: `setTimezoneOverride` changes what the
 * page reports, not the Windows clock. Reports say exactly that.
 */
export class EnvironmentConfigApplier {
  private readonly session: BrowserSessionPort;
  private readonly now: () => number;
  private readonly sessions = new Map<string, CdpSessionPort>();
  private readonly reports = new Map<string, PageConfigReport>();

  constructor(session: BrowserSessionPort, now: () => number) {
    this.session = session;
    this.now = now;
  }

  /** Apply every declared field to every current page. */
  async apply(
    resolved: ResolvedBrowserEnvironment,
  ): Promise<EnvironmentConfigReport> {
    for (const page of this.session.pages()) {
      await this.applyToPage(page, resolved);
    }
    return this.buildReport(resolved);
  }

  /** Apply and then read each declared field back from every page. */
  async verify(
    resolved: ResolvedBrowserEnvironment,
    options: ApplyConfigOptions,
  ): Promise<EnvironmentConfigReport> {
    for (const page of this.session.pages()) {
      await this.verifyPage(page, resolved, options);
    }
    return this.buildReport(resolved);
  }

  async applyToPage(
    page: BrowserPagePort,
    resolved: ResolvedBrowserEnvironment,
  ): Promise<PageConfigReport> {
    const config = resolved.config;
    const fields: ConfigFieldResult[] = [];

    if (config.timezone !== undefined) {
      fields.push(
        await this.command(
          page,
          "timezone",
          config.timezone,
          "Emulation.setTimezoneOverride",
          { timezoneId: config.timezone },
        ),
      );
    }

    if (resolved.canonicalLocale !== undefined) {
      const locale = resolved.canonicalLocale;
      fields.push(
        await this.command(
          page,
          "locale",
          locale,
          "Emulation.setLocaleOverride",
          { locale },
        ),
      );
      fields.push(await this.applyAcceptLanguage(page, locale));
    }

    if (resolved.viewport !== undefined) {
      const viewport = resolved.viewport;
      fields.push(
        await this.command(
          page,
          "viewport",
          viewportValue(viewport),
          "Emulation.setDeviceMetricsOverride",
          {
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
            mobile: false,
          },
        ),
      );
      if (viewport.deviceScaleFactor !== undefined) {
        fields.push(
          await this.command(
            page,
            "deviceScaleFactor",
            viewport.deviceScaleFactor,
            "Emulation.setDeviceMetricsOverride",
            {
              width: viewport.width,
              height: viewport.height,
              deviceScaleFactor: viewport.deviceScaleFactor,
              mobile: false,
            },
          ),
        );
      }
    }

    if (resolved.geolocation !== undefined) {
      fields.push(await this.applyGeolocation(page, resolved.geolocation));
    }

    const report: PageConfigReport = {
      pageId: page.pageId,
      url: page.url(),
      fields,
    };
    this.reports.set(page.pageId, report);
    return report;
  }

  async verifyPage(
    page: BrowserPagePort,
    resolved: ResolvedBrowserEnvironment,
    options: ApplyConfigOptions,
  ): Promise<PageConfigReport> {
    const applied = await this.applyToPage(page, resolved);
    const timeoutMs = options.timeoutMs ?? 5_000;
    const fields: ConfigFieldResult[] = [];

    for (const appliedField of applied.fields) {
      if (
        appliedField.status === "failed" ||
        appliedField.status === "unsupported"
      ) {
        fields.push(appliedField);
        continue;
      }
      fields.push(
        await this.verifyField(
          page,
          appliedField,
          resolved.config,
          options,
          timeoutMs,
        ),
      );
    }

    const report: PageConfigReport = {
      pageId: page.pageId,
      url: page.url(),
      fields,
    };
    this.reports.set(page.pageId, report);
    return report;
  }

  /** Build an aggregate report from the last results for every live page. */
  buildReport(resolved: ResolvedBrowserEnvironment): EnvironmentConfigReport {
    const pages = this.session
      .pages()
      .map((page) => this.reports.get(page.pageId))
      .filter((report): report is PageConfigReport => report !== undefined);

    return {
      environmentId: resolved.config.id,
      capturedAtUnixMs: this.now(),
      fields: aggregateFields(resolved.config, pages),
      pages,
    };
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.reports.clear();
    await Promise.all(
      sessions.map(async (session) => {
        try {
          await session.detach();
        } catch {
          // The page may already be gone; nothing else to release.
        }
      }),
    );
  }

  private async command(
    page: BrowserPagePort,
    field: ConfigField,
    requested: ConfigFieldValue,
    method: string,
    params: Record<string, unknown>,
  ): Promise<ConfigFieldResult> {
    try {
      const session = await this.cdpSession(page);
      await session.send(method, params);
      return applied(field, requested, method);
    } catch (error) {
      return failure(
        field,
        requested,
        method,
        `CDP ${method} failed: ${describeError(error)}`,
      );
    }
  }

  private async applyAcceptLanguage(
    page: BrowserPagePort,
    locale: string,
  ): Promise<ConfigFieldResult> {
    const header = acceptLanguageHeader(locale);
    try {
      const userAgent = await page.evaluate<string>("navigator.userAgent");
      const session = await this.cdpSession(page);
      await session.send("Network.setUserAgentOverride", {
        userAgent,
        acceptLanguage: header,
      });
      return applied("acceptLanguage", header, "Network.setUserAgentOverride");
    } catch (error) {
      return failure(
        "acceptLanguage",
        header,
        "Network.setUserAgentOverride",
        `CDP Network.setUserAgentOverride failed: ${describeError(error)}`,
      );
    }
  }

  private async applyGeolocation(
    page: BrowserPagePort,
    geolocation: GeolocationConfig,
  ): Promise<ConfigFieldResult> {
    const requested = geolocationValue(geolocation);
    try {
      await this.session.sendBrowserCommand("Browser.grantPermissions", {
        permissions: ["geolocation"],
      });
      const session = await this.cdpSession(page);
      await session.send("Emulation.setGeolocationOverride", {
        latitude: geolocation.latitude,
        longitude: geolocation.longitude,
        accuracy: geolocation.accuracy ?? 0,
      });
      return applied(
        "geolocation",
        requested,
        "Emulation.setGeolocationOverride",
      );
    } catch (error) {
      return failure(
        "geolocation",
        requested,
        "Emulation.setGeolocationOverride",
        `CDP geolocation setup failed: ${describeError(error)}`,
      );
    }
  }

  private async verifyField(
    page: BrowserPagePort,
    appliedField: ConfigFieldResult,
    config: BrowserEnvironmentConfig,
    options: ApplyConfigOptions,
    timeoutMs: number,
  ): Promise<ConfigFieldResult> {
    switch (appliedField.field) {
      case "timezone":
        return this.verifyTimezone(page, config.timezone);
      case "locale":
        return this.verifyLocale(page, config.locale);
      case "acceptLanguage":
        return this.verifyAcceptLanguage(page, config.locale, options);
      case "viewport":
        return this.verifyViewport(page, config.viewport);
      case "deviceScaleFactor":
        return this.verifyDeviceScaleFactor(page, config.viewport);
      case "geolocation":
        return this.verifyGeolocation(page, config.geolocation, timeoutMs);
      default:
        return appliedField;
    }
  }

  private async verifyTimezone(
    page: BrowserPagePort,
    requested: string | undefined,
  ): Promise<ConfigFieldResult> {
    const expression = "Intl.DateTimeFormat().resolvedOptions().timeZone";
    try {
      const observed = await page.evaluate<string>(expression);
      const matches = observed.toLowerCase() === requested?.toLowerCase();
      return verification(
        "timezone",
        requested,
        observed,
        matches,
        "Intl.DateTimeFormat().resolvedOptions().timeZone",
      );
    } catch (error) {
      return unverified(
        "timezone",
        requested,
        "Intl.DateTimeFormat",
        describeError(error),
      );
    }
  }

  private async verifyLocale(
    page: BrowserPagePort,
    requested: string | undefined,
  ): Promise<ConfigFieldResult> {
    try {
      const observed = await page.evaluate<LocaleObservation>(
        "({ language: navigator.language, languages: navigator.languages.join(',') })",
      );
      const canonicalRequested =
        requested === undefined
          ? undefined
          : Intl.getCanonicalLocales(requested)[0];
      const canonicalObserved = safeCanonical(observed.language);
      const matches =
        canonicalRequested !== undefined &&
        canonicalRequested.toLowerCase() === canonicalObserved?.toLowerCase();
      return verification(
        "locale",
        canonicalRequested ?? requested,
        {
          language: observed.language,
          languages: observed.languages,
        },
        matches,
        "navigator.language",
      );
    } catch (error) {
      return unverified(
        "locale",
        requested,
        "navigator.language",
        describeError(error),
      );
    }
  }

  private async verifyAcceptLanguage(
    page: BrowserPagePort,
    locale: string | undefined,
    options: ApplyConfigOptions,
  ): Promise<ConfigFieldResult> {
    const requested =
      locale === undefined ? undefined : acceptLanguageHeader(locale);
    if (options.networkProbeUrl === undefined) {
      return {
        field: "acceptLanguage",
        status: "not_verified",
        requested,
        observed: undefined,
        reason:
          "no network probe URL was configured; the HTTP header was set but not observed",
        capability: "Network.setUserAgentOverride",
      };
    }

    const probeUrl = options.networkProbeUrl;
    const expression = `(async () => {
      const response = await fetch(${JSON.stringify(probeUrl)}, { cache: "no-store" });
      return await response.json();
    })()`;

    try {
      const observed = await page.evaluate<unknown>(expression);
      const acceptLanguage =
        typeof observed === "object" &&
        observed !== null &&
        "acceptLanguage" in observed &&
        typeof observed.acceptLanguage === "string"
          ? observed.acceptLanguage
          : undefined;
      if (acceptLanguage === undefined) {
        return unverified(
          "acceptLanguage",
          requested,
          "network probe",
          "the probe did not return an acceptLanguage string",
        );
      }
      const expectedLanguage = requested?.split(",")[0]?.trim().toLowerCase();
      return verification(
        "acceptLanguage",
        requested,
        acceptLanguage,
        expectedLanguage !== undefined &&
          acceptLanguage.toLowerCase().includes(expectedLanguage),
        "HTTP Accept-Language",
      );
    } catch (error) {
      return unverified(
        "acceptLanguage",
        requested,
        "network probe",
        describeError(error),
      );
    }
  }

  private async verifyViewport(
    page: BrowserPagePort,
    requested: ViewportConfig | undefined,
  ): Promise<ConfigFieldResult> {
    try {
      const observed = await page.evaluate<ViewportObservation>(
        "({ width: window.innerWidth, height: window.innerHeight, screenWidth: screen.width, screenHeight: screen.height, devicePixelRatio: window.devicePixelRatio })",
      );
      const matches =
        observed.width === requested?.width &&
        observed.height === requested?.height;
      return verification(
        "viewport",
        requested === undefined ? undefined : viewportValue(requested),
        {
          width: observed.width,
          height: observed.height,
          screenWidth: observed.screenWidth,
          screenHeight: observed.screenHeight,
        },
        matches,
        "window.innerWidth/innerHeight",
      );
    } catch (error) {
      return unverified(
        "viewport",
        requested === undefined ? undefined : viewportValue(requested),
        "window.innerWidth",
        describeError(error),
      );
    }
  }

  private async verifyDeviceScaleFactor(
    page: BrowserPagePort,
    requested: ViewportConfig | undefined,
  ): Promise<ConfigFieldResult> {
    const expected = requested?.deviceScaleFactor;
    try {
      const observed = await page.evaluate<number>("window.devicePixelRatio");
      return verification(
        "deviceScaleFactor",
        expected,
        observed,
        expected !== undefined && Math.abs(observed - expected) < 0.001,
        "window.devicePixelRatio",
      );
    } catch (error) {
      return unverified(
        "deviceScaleFactor",
        expected,
        "window.devicePixelRatio",
        describeError(error),
      );
    }
  }

  private async verifyGeolocation(
    page: BrowserPagePort,
    requested: GeolocationConfig | undefined,
    timeoutMs: number,
  ): Promise<ConfigFieldResult> {
    const expression = `(() => new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve({ supported: false });
        return;
      }
      const timer = setTimeout(() => resolve({ supported: true, timedOut: true }), ${String(timeoutMs)});
      navigator.geolocation.getCurrentPosition(
        (position) => {
          clearTimeout(timer);
          resolve({
            supported: true,
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
        },
        (error) => {
          clearTimeout(timer);
          resolve({ supported: true, error: error.message, code: error.code });
        },
        { timeout: ${String(Math.max(timeoutMs - 500, 1_000))} }
      );
    }))()`;

    try {
      const observed = await page.evaluate<GeolocationObservation>(expression);
      if (!observed.supported) {
        return {
          field: "geolocation",
          status: "unsupported",
          requested:
            requested === undefined ? undefined : geolocationValue(requested),
          observed: undefined,
          reason: "navigator.geolocation is not available in this page",
          capability: "navigator.geolocation",
        };
      }
      if (observed.timedOut === true) {
        return unverified(
          "geolocation",
          requested === undefined ? undefined : geolocationValue(requested),
          "navigator.geolocation",
          "geolocation permission did not resolve before the timeout",
        );
      }
      if (observed.error !== undefined) {
        return {
          field: "geolocation",
          status: "failed",
          requested:
            requested === undefined ? undefined : geolocationValue(requested),
          observed: observed.error,
          reason: `geolocation was denied or unavailable: ${observed.error}`,
          capability: "navigator.geolocation",
        };
      }

      const latitude = observed.latitude;
      const longitude = observed.longitude;
      const matches =
        requested !== undefined &&
        latitude !== undefined &&
        longitude !== undefined &&
        Math.abs(latitude - requested.latitude) < 0.000_001 &&
        Math.abs(longitude - requested.longitude) < 0.000_001;

      return verification(
        "geolocation",
        requested === undefined ? undefined : geolocationValue(requested),
        {
          latitude: latitude ?? Number.NaN,
          longitude: longitude ?? Number.NaN,
          accuracy: observed.accuracy ?? 0,
        },
        matches,
        "navigator.geolocation",
      );
    } catch (error) {
      return unverified(
        "geolocation",
        requested === undefined ? undefined : geolocationValue(requested),
        "navigator.geolocation",
        describeError(error),
      );
    }
  }

  private async cdpSession(page: BrowserPagePort): Promise<CdpSessionPort> {
    const existing = this.sessions.get(page.pageId);
    if (existing !== undefined) {
      return existing;
    }
    const session = await page.createCdpSession();
    this.sessions.set(page.pageId, session);
    return session;
  }
}

function applied(
  field: ConfigField,
  requested: ConfigFieldValue,
  capability: string,
): ConfigFieldResult {
  return {
    field,
    status: "applied",
    requested,
    observed: undefined,
    reason: undefined,
    capability,
  };
}

function failure(
  field: ConfigField,
  requested: ConfigFieldValue,
  capability: string,
  reason: string,
): ConfigFieldResult {
  return {
    field,
    status: "failed",
    requested,
    observed: undefined,
    reason,
    capability,
  };
}

function unverified(
  field: ConfigField,
  requested: ConfigFieldValue | undefined,
  capability: string,
  reason: string,
): ConfigFieldResult {
  return {
    field,
    status: "not_verified",
    requested,
    observed: undefined,
    reason,
    capability,
  };
}

function verification(
  field: ConfigField,
  requested: ConfigFieldValue | undefined,
  observed: ConfigFieldValue,
  matches: boolean,
  capability: string,
): ConfigFieldResult {
  return {
    field,
    status: matches ? "verified" : "failed",
    requested,
    observed,
    reason: matches
      ? undefined
      : "the page reported a different value than the configuration requested",
    capability,
  };
}

function viewportValue(
  viewport: ViewportConfig,
): Readonly<Record<string, number>> {
  return {
    width: viewport.width,
    height: viewport.height,
    ...(viewport.deviceScaleFactor === undefined
      ? {}
      : { deviceScaleFactor: viewport.deviceScaleFactor }),
  };
}

function geolocationValue(
  geolocation: GeolocationConfig,
): Readonly<Record<string, number>> {
  return {
    latitude: geolocation.latitude,
    longitude: geolocation.longitude,
    accuracy: geolocation.accuracy ?? 0,
  };
}

/**
 * Chrome formats a language list into the HTTP header itself (adding q-values),
 * so the override carries bare tags rather than a pre-built header string.
 */
function acceptLanguageHeader(locale: string): string {
  const language = locale.split("-")[0] ?? locale;
  return language === locale ? locale : `${locale},${language}`;
}

function safeCanonical(locale: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-control-regex
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}

const AGGREGATE_PRIORITY: Readonly<Record<ConfigFieldStatus, number>> = {
  failed: 5,
  unsupported: 4,
  not_verified: 3,
  applied: 2,
  verified: 1,
};

function aggregateFields(
  config: BrowserEnvironmentConfig,
  pages: readonly PageConfigReport[],
): readonly ConfigFieldResult[] {
  const declared = declaredFields(config);
  return declared.map((field) => {
    const results = pages.flatMap((page) =>
      page.fields.filter((entry) => entry.field === field),
    );
    const fallback: ConfigFieldResult = {
      field,
      status: "not_verified",
      requested: requestedFor(config, field),
      observed: undefined,
      reason: "no live page was available to observe this setting",
      capability: undefined,
    };
    if (results.length === 0) {
      return fallback;
    }

    let worst = results[0];
    for (const result of results) {
      if (
        worst === undefined ||
        AGGREGATE_PRIORITY[result.status] > AGGREGATE_PRIORITY[worst.status]
      ) {
        worst = result;
      }
    }
    return worst ?? fallback;
  });
}

function declaredFields(
  config: BrowserEnvironmentConfig,
): readonly ConfigField[] {
  const fields: ConfigField[] = [];
  if (config.timezone !== undefined) {
    fields.push("timezone");
  }
  if (config.locale !== undefined) {
    fields.push("locale", "acceptLanguage");
  }
  if (config.viewport !== undefined) {
    fields.push("viewport");
    if (config.viewport.deviceScaleFactor !== undefined) {
      fields.push("deviceScaleFactor");
    }
  }
  if (config.geolocation !== undefined) {
    fields.push("geolocation");
  }
  return fields;
}

function requestedFor(
  config: BrowserEnvironmentConfig,
  field: ConfigField,
): ConfigFieldValue | undefined {
  switch (field) {
    case "timezone":
      return config.timezone;
    case "locale":
      return config.locale;
    case "acceptLanguage":
      return config.locale === undefined
        ? undefined
        : acceptLanguageHeader(config.locale);
    case "viewport":
      return config.viewport === undefined
        ? undefined
        : viewportValue(config.viewport);
    case "deviceScaleFactor":
      return config.viewport?.deviceScaleFactor;
    case "geolocation":
      return config.geolocation === undefined
        ? undefined
        : geolocationValue(config.geolocation);
    default:
      return undefined;
  }
}
