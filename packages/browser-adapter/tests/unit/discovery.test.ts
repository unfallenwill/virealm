import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareVersionsDescending,
  discoverBrowsers,
  inspectExecutable,
  versionFromInstallPath,
} from "../../src/chrome/discovery.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "virealm-discovery-"));
  roots.push(root);
  return root;
}

function installChrome(programFiles: string, version: string): string {
  const directory = path.join(
    programFiles,
    "Google",
    "Chrome",
    "Application",
    version,
  );
  mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, "chrome.exe");
  writeFileSync(executable, "");
  return executable;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("discoverBrowsers", () => {
  it("returns the highest version first across roots, without duplicates", () => {
    const programFiles = makeRoot();
    const localAppData = makeRoot();
    const older = installChrome(programFiles, "155.0.8000.10");
    const newer = installChrome(programFiles, "156.0.8078.48");
    const perUser = installChrome(localAppData, "157.0.1000.1");

    const found = discoverBrowsers({
      roots: { programFiles, localAppData },
    });

    expect(found.map((entry) => entry.executablePath)).toEqual([
      newer,
      older,
      perUser,
    ]);
    expect(found.every((entry) => entry.source !== "explicit")).toBe(true);
  });

  it("skips empty and missing roots", () => {
    expect(
      discoverBrowsers({ roots: { programFiles: "", localAppData: "" } }),
    ).toEqual([]);
  });

  it("ignores a directory named like the executable", () => {
    const root = makeRoot();
    const executable = path.join(root, "chrome.exe");
    mkdirSync(executable);
    expect(inspectExecutable(executable, "test")).toBeUndefined();
    expect(
      inspectExecutable(path.join(root, "chrome.dll"), "test"),
    ).toBeUndefined();
  });

  it("returns nothing when no standard root contains Chrome", () => {
    const programFiles = makeRoot();
    expect(discoverBrowsers({ roots: { programFiles } })).toEqual([]);
  });

  it("inspects an explicit executable first and extra candidates next", () => {
    const root = makeRoot();
    const explicit = installChrome(root, "156.0.8078.48");
    const extraRoot = makeRoot();
    const extra = installChrome(extraRoot, "155.0.1.1");

    const found = discoverBrowsers({
      executablePath: explicit,
      extraPaths: [extra],
      roots: { programFiles: makeRoot(), localAppData: makeRoot() },
    });

    expect(found).toHaveLength(2);
    expect(found[0]?.source).toBe("explicit");
    expect(found[1]?.source).toBe("extra");
    expect(found[1]?.version).toBe("155.0.1.1");
  });

  it("falls back to a version-less launcher in the Application directory", () => {
    const programFiles = makeRoot();
    const application = path.join(
      programFiles,
      "Google",
      "Chrome",
      "Application",
    );
    mkdirSync(application, { recursive: true });
    const launcher = path.join(application, "chrome.exe");
    writeFileSync(launcher, "");

    const found = discoverBrowsers({ roots: { programFiles } });
    expect(found).toHaveLength(1);
    expect(found[0]?.version).toBe("unknown");
  });

  it("ignores a missing Application directory", () => {
    const programFiles = makeRoot();
    expect(
      discoverBrowsers({
        roots: { programFiles: path.join(programFiles, "missing") },
      }),
    ).toEqual([]);
  });
});

describe("inspectExecutable", () => {
  it("rejects non-Chrome names, non-exe files and directories", () => {
    const root = makeRoot();
    const notChrome = path.join(root, "notepad.exe");
    writeFileSync(notChrome, "");
    const notExe = path.join(root, "chrome.txt");
    writeFileSync(notExe, "");
    mkdirSync(path.join(root, "chrome.exe"));

    expect(inspectExecutable(notChrome, "test")).toBeUndefined();
    expect(inspectExecutable(notExe, "test")).toBeUndefined();
    expect(
      inspectExecutable(path.join(root, "chrome.exe"), "test"),
    ).toBeUndefined();
    expect(
      inspectExecutable(path.join(root, "missing.exe"), "test"),
    ).toBeUndefined();
  });

  it("accepts chromium.exe and uses a provided known version", () => {
    const root = makeRoot();
    const executable = path.join(root, "chromium.exe");
    writeFileSync(executable, "");
    const browser = inspectExecutable(executable, "extra", "1.2.3.4");
    expect(browser?.version).toBe("1.2.3.4");
  });
});

describe("version helpers", () => {
  it("reads a version only from a four-part install directory", () => {
    expect(
      versionFromInstallPath("C:\\Chrome\\Application\\1.2.3.4\\chrome.exe"),
    ).toBe("1.2.3.4");
    expect(
      versionFromInstallPath("C:\\Chrome\\Application\\chrome.exe"),
    ).toBeUndefined();
  });

  it("infers the current layout's version from a sibling payload directory", () => {
    const root = makeRoot();
    const application = path.join(root, "Application");
    mkdirSync(path.join(application, "155.0.8000.10"), { recursive: true });
    mkdirSync(path.join(application, "156.0.8078.48"), { recursive: true });
    const launcher = path.join(application, "chrome.exe");
    writeFileSync(launcher, "");

    expect(versionFromInstallPath(launcher)).toBe("156.0.8078.48");
    expect(inspectExecutable(launcher, "explicit")?.version).toBe(
      "156.0.8078.48",
    );
  });

  it("uses the sibling version for an install whose launcher is only in Application", () => {
    const programFiles = makeRoot();
    const application = path.join(
      programFiles,
      "Google",
      "Chrome",
      "Application",
    );
    mkdirSync(path.join(application, "156.0.8078.48"), { recursive: true });
    writeFileSync(path.join(application, "chrome.exe"), "");

    const found = discoverBrowsers({ roots: { programFiles } });
    expect(found).toHaveLength(1);
    expect(found[0]?.executablePath).toBe(path.join(application, "chrome.exe"));
    expect(found[0]?.version).toBe("156.0.8078.48");
  });

  it("orders versions numerically, not lexically", () => {
    expect(compareVersionsDescending("156.0.8078.48", "99.0.1.1")).toBeLessThan(
      0,
    );
    expect(
      compareVersionsDescending("99.0.1.1", "156.0.8078.48"),
    ).toBeGreaterThan(0);
    expect(compareVersionsDescending("1.2.3.4", "1.2.3.4")).toBe(0);
  });
});
