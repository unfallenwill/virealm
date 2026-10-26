import { randomUUID } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  Capability,
  CapabilityReport,
  CapabilityState,
} from "@virealm/contracts";
import { describe, expect, it } from "vitest";

import { DesktopLog } from "../../src/main/logging.js";
import {
  RuntimeController,
  defaultEndpoint,
  endpointKind,
  isolationViews,
} from "../../src/main/runtime/runtime-controller.js";

function capability(state: CapabilityState, detail?: string): Capability {
  return detail === undefined ? { state } : { state, detail };
}

function reportFor(
  overrides: Partial<CapabilityReport> = {},
): CapabilityReport {
  return {
    platform: {
      os: "windows",
      version: { major: 10, minor: 0, build: 22_631 },
      architecture: "x86_64",
      elevated: false,
      integrityLevel: "medium",
    },
    jobObject: capability("supported"),
    appContainer: capability("unsupported"),
    appContainerAcl: capability("supported"),
    restrictedToken: capability("supported"),
    processMitigation: capability("supported"),
    etw: capability("supported"),
    ...overrides,
  };
}

function macosReport(
  overrides: Partial<CapabilityReport> = {},
): CapabilityReport {
  return reportFor({
    platform: {
      os: "macos",
      osVersion: "27.0.1",
      version: { major: 27, minor: 0, build: 1 },
      architecture: "arm64",
      elevated: false,
      integrityLevel: "unknown",
    },
    jobObject: capability("unsupported", "Windows only"),
    appContainer: capability("unsupported", "Windows only"),
    appContainerAcl: capability("unsupported", "Windows only"),
    restrictedToken: capability("unsupported", "Windows only"),
    processMitigation: capability("unsupported", "Windows only"),
    etw: capability("unsupported", "Windows only"),
    processGroup: capability("supported"),
    unixSocket: capability("supported"),
    processIdentity: capability("supported"),
    resourceLimits: {
      maxProcesses: capability("unavailable"),
      memoryLimit: capability("unavailable"),
    },
    ...overrides,
  });
}

describe("defaultEndpoint", () => {
  it("uses a named pipe on Windows", () => {
    expect(defaultEndpoint("win32")).toMatch(
      /^\\\\\.\\pipe\\virealm-desktop-\d+-[0-9a-f]{8}$/u,
    );
  });

  it("uses a bounded absolute Unix socket path on macOS", () => {
    const endpoint = defaultEndpoint("darwin");
    expect(path.isAbsolute(endpoint)).toBe(true);
    expect(endpoint.endsWith(".sock")).toBe(true);
    expect(Buffer.byteLength(endpoint)).toBeLessThanOrEqual(100);
  });
});

describe("endpoint cleanup", () => {
  function controller(pipePath?: string): RuntimeController {
    return new RuntimeController({
      appRoot: process.cwd(),
      isPackaged: false,
      resourcesPath: process.cwd(),
      log: new DesktopLog(),
      ...(pipePath === undefined ? {} : { pipePath }),
    });
  }

  it.skipIf(process.platform === "win32")(
    "removes the socket it generated when stopped",
    async () => {
      const runtime = controller();
      const lock = `${runtime.pipePath}.lock`;
      await writeFile(runtime.pipePath, "");
      await writeFile(lock, "");

      await runtime.stop();

      await expect(stat(runtime.pipePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves an endpoint it did not generate alone",
    async () => {
      const pipePath = path.join(
        "/tmp",
        `virealm-explicit-${randomUUID().slice(0, 8)}.sock`,
      );
      await writeFile(pipePath, "");
      const runtime = controller(pipePath);

      await runtime.stop();

      await expect(stat(pipePath)).resolves.toBeDefined();
    },
  );
});

describe("endpointKind", () => {
  it("names the transport in user-facing wording", () => {
    expect(endpointKind(String.raw`\\.\pipe\virealm`)).toBe("命名管道");
    expect(endpointKind("/tmp/virealm.sock")).toBe("Unix 套接字");
  });
});

describe("isolationViews", () => {
  it("reads the Windows keys on Windows", () => {
    const views = isolationViews(reportFor());
    expect(views.map((view) => [view.mode, view.state])).toEqual([
      ["managed", "supported"],
      ["restricted", "supported"],
      ["app_container", "unsupported"],
    ]);
    expect(views[0]?.detail).toContain("Job Object");
  });

  it("reads only the process group on macOS", () => {
    const views = isolationViews(macosReport());
    expect(views.map((view) => [view.mode, view.state])).toEqual([
      ["managed", "supported"],
      ["restricted", "unsupported"],
      ["app_container", "unsupported"],
    ]);
    expect(views[0]?.detail).toContain("进程组管理");
    expect(views[0]?.detail).toContain("POSIX 进程组");
    expect(views[1]?.detail).toContain("macOS 不支持");
    expect(views[2]?.detail).toContain("AppContainer");
  });

  it("does not claim a process group the runtime has not verified", () => {
    const views = isolationViews(
      macosReport({ processGroup: capability("not_verified") }),
    );
    expect(views[0]?.state).toBe("not_verified");
  });

  it("reports an unavailable process group instead of failing", () => {
    const views = isolationViews(
      macosReport({ processGroup: capability("unavailable") }),
    );
    expect(views[0]?.state).toBe("unavailable");
  });
});
