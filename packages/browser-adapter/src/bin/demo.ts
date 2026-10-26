import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { RuntimeHost } from "@virealm/runtime-client";

import {
  BrowserAdapter,
  isBrowserAdapterError,
  type BrowserEnvironmentConfig,
  type ConfigFieldResult,
  type EnvironmentConfigReport,
  type EnvironmentStatus,
} from "../index.js";

/**
 * Non-UI demo of the public adapter API.
 *
 * It boots a real `virealm-runtime` daemon on a dedicated endpoint, launches two
 * real Chrome environments through it, verifies timezone/locale/viewport and
 * Accept-Language on local controlled pages, then stops both and reports what
 * was cleaned up. Nothing here is mocked, and no external site is contacted.
 */

interface DemoOptions {
  readonly runtime?: string;
  readonly chrome?: string;
  readonly dataRoot: string;
}

const DEMO_ENVIRONMENTS: readonly {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly locale: string;
  readonly width: number;
  readonly height: number;
}[] = [
  {
    id: "demo-a",
    name: "Demo Singapore",
    timezone: "Asia/Singapore",
    locale: "en-US",
    width: 1_200,
    height: 800,
  },
  {
    id: "demo-b",
    name: "Demo Los Angeles",
    timezone: "America/Los_Angeles",
    locale: "en-GB",
    width: 1_024,
    height: 768,
  },
];

function parseArguments(argv: readonly string[]): DemoOptions {
  let runtime: string | undefined;
  let chrome: string | undefined;
  let dataRoot: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--runtime" && value !== undefined) {
      runtime = value;
      index += 1;
    } else if (flag === "--chrome" && value !== undefined) {
      chrome = value;
      index += 1;
    } else if (flag === "--data-root" && value !== undefined) {
      dataRoot = value;
      index += 1;
    } else if (flag === "--help" || flag === "-h") {
      printUsage();
      process.exitCode = 0;
    } else {
      throw new Error(`unknown or incomplete argument: ${String(flag)}`);
    }
  }

  return {
    ...(runtime === undefined ? {} : { runtime }),
    ...(chrome === undefined ? {} : { chrome }),
    dataRoot:
      dataRoot === undefined
        ? path.join(tmpdir(), "virealm-demo")
        : path.resolve(dataRoot),
  };
}

const runtimeFileName =
  process.platform === "win32" ? "virealm-runtime.exe" : "virealm-runtime";

function printUsage(): void {
  console.log(`Usage: pnpm demo [options]

  --runtime <path>    ${runtimeFileName} (default: VIREALM_RUNTIME_EXECUTABLE,
                      then target/debug/${runtimeFileName})
  --chrome <path>     Chrome executable (default: discovered install)
  --data-root <path>  Virealm data root (default: <tmp>/virealm-demo)
  -h, --help          show this text
`);
}

function resolveRuntime(explicit: string | undefined): string | undefined {
  const candidates = [
    explicit,
    process.env.VIREALM_RUNTIME_EXECUTABLE,
    path.resolve(process.cwd(), "target", "debug", runtimeFileName),
    path.resolve(process.cwd(), "..", "..", "target", "debug", runtimeFileName),
  ];
  return candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined && existsSync(candidate),
  );
}

/** Endpoint the demo runtime serves on: a named pipe or Unix socket. */
function demoEndpoint(): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\virealm-demo-${String(process.pid)}`
    : path.join(tmpdir(), `virealm-demo-${String(process.pid)}.sock`);
}

function configFor(
  environment: (typeof DEMO_ENVIRONMENTS)[number],
  executablePath: string,
  version: string | undefined,
  baseUrl: string,
): BrowserEnvironmentConfig {
  return {
    id: environment.id,
    name: environment.name,
    browser: {
      executablePath,
      ...(version === undefined ? {} : { version }),
    },
    timezone: environment.timezone,
    locale: environment.locale,
    viewport: { width: environment.width, height: environment.height },
    runtimePolicy: { isolation: "managed" },
    persistence: { mode: "persistent" },
    launch: {
      initialUrls: [`${baseUrl}/page-${environment.id}`],
      additionalArguments: ["--headless=new"],
    },
  };
}

function describeField(result: ConfigFieldResult): string {
  const observed =
    result.observed === undefined ? "-" : JSON.stringify(result.observed);
  const suffix =
    result.reason === undefined
      ? ""
      : ` reason=${JSON.stringify(result.reason)}`;
  return `${result.field.padEnd(16)} ${result.status.padEnd(12)} requested=${JSON.stringify(
    result.requested,
  )} observed=${observed}${suffix}`;
}

function printReport(report: EnvironmentConfigReport): void {
  console.log(`  verification captured at ${String(report.capturedAtUnixMs)}`);
  for (const result of report.fields) {
    console.log(`  ${describeField(result)}`);
  }
  const failed = report.fields.filter(
    (result) => result.status === "failed" || result.status === "unsupported",
  );
  console.log(
    `  ${String(report.pages.length)} page(s); ${String(failed.length)} failed field(s)`,
  );
}

function printStatus(status: EnvironmentStatus): void {
  const endpoint =
    status.cdp.endpoint === undefined ? "-" : new URL(status.cdp.endpoint).host;
  console.log(
    `  state=${status.state} pid=${String(status.pid ?? "-")} cdp=${
      status.cdp.connected ? `connected (${endpoint})` : "disconnected"
    }`,
  );
  console.log(
    `  profile=${status.userDataDir ?? "-"} chrome=${status.browserVersion ?? "-"}`,
  );
}

async function endpointAnswers(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  url.protocol = "http:";
  url.pathname = "/json/version";
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function run(): Promise<number> {
  const options = parseArguments(process.argv.slice(2));
  if (process.exitCode !== undefined) {
    return 0;
  }

  const runtimeExecutable = resolveRuntime(options.runtime);
  if (runtimeExecutable === undefined) {
    console.error(
      `No ${runtimeFileName} found. Build it with:\n` +
        "  cargo build -p virealm-process-runtime --bin virealm-runtime\n" +
        "then pass --runtime <path> or set VIREALM_RUNTIME_EXECUTABLE.",
    );
    return 2;
  }

  const pipePath = demoEndpoint();
  const server = createServer((request, response) => {
    const route = request.url ?? "/";
    if (route === "/headers") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({
          acceptLanguage: request.headers["accept-language"] ?? null,
        }),
      );
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      `<!doctype html><html><head><title>virealm demo ${route}</title></head>` +
        `<body><h1>Virealm controlled page</h1><p>${route}</p></body></html>`,
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  console.log("Virealm browser adapter demo");
  console.log(`  runtime   ${runtimeExecutable}`);
  console.log(`  endpoint  ${pipePath}`);
  console.log(`  data root ${options.dataRoot}`);
  console.log(`  pages     ${baseUrl}`);

  let host: RuntimeHost | undefined;
  let adapter: BrowserAdapter | undefined;
  const launched: string[] = [];
  let exitCode = 0;

  try {
    host = await RuntimeHost.start({
      executablePath: runtimeExecutable,
      pipePath,
      startupTimeoutMs: 20_000,
    });
    const active = new BrowserAdapter({
      dataRoot: options.dataRoot,
      runtimePipePath: pipePath,
      networkProbeUrl: `${baseUrl}/headers`,
    });
    adapter = active;

    const browsers = active.discoverBrowsers(options.chrome);
    console.log(
      `\nDiscovered ${String(browsers.length)} Chrome installation(s):`,
    );
    for (const browser of browsers) {
      console.log(
        `  ${browser.executablePath} version=${browser.version} source=${browser.source}`,
      );
    }
    const browser = browsers[0];
    if (browser === undefined) {
      console.error(
        "Chrome was not found. Install Chrome or pass --chrome <path>.",
      );
      return 3;
    }

    for (const environment of DEMO_ENVIRONMENTS) {
      console.log(`\nLaunching ${environment.id} (${environment.name})`);
      const version =
        browser.version === "unknown" ? undefined : browser.version;
      const config = configFor(
        environment,
        browser.executablePath,
        version,
        baseUrl,
      );

      const validation = active.validateEnvironment(config);
      if (!validation.valid) {
        throw new Error(
          `${environment.id} configuration was rejected: ${JSON.stringify(
            validation.issues,
          )}`,
        );
      }

      const result = await active.launchEnvironment(config);
      launched.push(environment.id);
      printStatus(result.status);

      const report = await active.verifyEnvironmentConfig(environment.id);
      printReport(report);
    }

    console.log("\nOpening and navigating a target in demo-a");
    const opened = await active.openPage("demo-a", `${baseUrl}/page-opened`);
    console.log(`  opened ${opened.pageId} url=${opened.url}`);
    const navigated = await active.navigatePage(
      "demo-a",
      opened.pageId,
      `${baseUrl}/page-navigated`,
    );
    console.log(`  navigated ${navigated.pageId} url=${navigated.url}`);
    await active.closePage("demo-a", opened.pageId);
    console.log("  closed the extra target");

    console.log("\nChecking isolation facts");
    const statusA = await active.getEnvironmentStatus("demo-a");
    const statusB = await active.getEnvironmentStatus("demo-b");
    const endpointA = statusA.cdp.endpoint;
    const endpointB = statusB.cdp.endpoint;
    console.log(
      `  profiles differ: ${String(statusA.userDataDir !== statusB.userDataDir)}`,
    );
    console.log(
      `  debug endpoints differ: ${String(
        endpointA !== undefined &&
          endpointB !== undefined &&
          endpointA !== endpointB,
      )}`,
    );
  } catch (error) {
    exitCode = 1;
    if (isBrowserAdapterError(error)) {
      console.error(`\nFAILED ${error.code}: ${error.message}`);
      if (error.details !== undefined) {
        console.error(`  details: ${JSON.stringify(error.details)}`);
      }
    } else {
      console.error(
        `\nFAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    if (adapter !== undefined) {
      for (const environmentId of launched) {
        console.log(`\nStopping ${environmentId}`);
        try {
          const before = await adapter.getEnvironmentStatus(environmentId);
          const stopped = await adapter.stopEnvironment(environmentId, {
            mode: "graceful",
            timeoutMs: 20_000,
          });
          printStatus(stopped);
          if (before.cdp.endpoint !== undefined) {
            console.log(
              `  debugging endpoint reachable after stop: ${String(
                await endpointAnswers(before.cdp.endpoint),
              )}`,
            );
          }
          console.log(
            `  profile kept on disk: ${String(
              existsSync(before.userDataDir ?? ""),
            )}`,
          );
        } catch (error) {
          console.error(
            `  stop failed: ${
              isBrowserAdapterError(error) ? error.code : String(error)
            }`,
          );
          exitCode = 1;
        }
      }
      await adapter.close();
    }
    if (host !== undefined) {
      await host.stop();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    console.log("\nRuntime daemon and local test server stopped.");
    console.log(
      `Profiles remain under ${options.dataRoot}; delete that directory to reset the demo.`,
    );
  }

  return exitCode;
}

process.exitCode = await run();
