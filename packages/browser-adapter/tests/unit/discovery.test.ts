import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareVersionsDescending,
  discoverBrowsers,
  inspectExecutable,
  versionFromInstallPath,
  versionFromMacBundle,
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
      platform: "win32",
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
      discoverBrowsers({
        roots: { programFiles: "", localAppData: "", applicationsRoots: [] },
        platform: "win32",
      }),
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
    expect(
      discoverBrowsers({ roots: { programFiles }, platform: "win32" }),
    ).toEqual([]);
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
      platform: "win32",
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

    const found = discoverBrowsers({
      roots: { programFiles },
      platform: "win32",
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.version).toBe("unknown");
  });

  it("ignores a missing Application directory", () => {
    const programFiles = makeRoot();
    expect(
      discoverBrowsers({
        roots: { programFiles: path.join(programFiles, "missing") },
        platform: "win32",
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
    const browser = inspectExecutable(executable, "extra", "1.2.3.4", "win32");
    expect(browser?.version).toBe("1.2.3.4");
  });
});

function installMacChrome(
  applicationsRoot: string,
  bundle: string,
  version: string | undefined,
  options: { readonly executableBit?: boolean } = {},
): string {
  const name = bundle.replace(/\.app$/, "");
  const executable = path.join(
    applicationsRoot,
    bundle,
    "Contents",
    "MacOS",
    name,
  );
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, "");
  chmodSync(executable, options.executableBit === false ? 0o644 : 0o755);

  if (version !== undefined) {
    mkdirSync(
      path.join(
        applicationsRoot,
        bundle,
        "Contents",
        "Frameworks",
        `${name} Framework.framework`,
        "Versions",
        version,
      ),
      { recursive: true },
    );
  }
  return executable;
}

describe("macOS app bundles", () => {
  it("finds bundles in an applications root and reads the framework version", () => {
    const root = makeRoot();
    const chrome = installMacChrome(root, "Google Chrome.app", "156.0.8078.48");

    const found = discoverBrowsers({
      roots: { applicationsRoots: [root], programFiles: undefined },
      platform: "darwin",
    });

    expect(found).toHaveLength(1);
    expect(found[0]?.executablePath).toBe(chrome);
    expect(found[0]?.version).toBe("156.0.8078.48");
    expect(found[0]?.source).toBe("applications");
  });

  it("finds Chromium, Canary and Chrome for Testing side by side", () => {
    const root = makeRoot();
    const chromium = installMacChrome(root, "Chromium.app", "155.0.1.1");
    const canary = installMacChrome(
      root,
      "Google Chrome Canary.app",
      "157.0.2.2",
    );
    const cft = installMacChrome(
      root,
      "Google Chrome for Testing.app",
      "156.0.3.3",
    );

    const found = discoverBrowsers({
      roots: { applicationsRoots: [root] },
      platform: "darwin",
    });

    expect(found.map((entry) => entry.executablePath)).toEqual([
      chromium,
      canary,
      cft,
    ]);
  });

  it("falls back to CFBundleShortVersionString when no framework exists", () => {
    const root = makeRoot();
    const executable = installMacChrome(root, "Google Chrome.app", undefined);
    writeFileSync(
      path.join(root, "Google Chrome.app", "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleShortVersionString</key>
  <string>157.0.1.0</string>
</dict></plist>
`,
    );

    const browser = inspectExecutable(executable, "test", undefined, "darwin");

    expect(browser?.version).toBe("157.0.1.0");
  });

  it("requires the executable bit where the host has one", () => {
    const root = makeRoot();
    installMacChrome(root, "Google Chrome.app", "156.0.8078.48", {
      executableBit: false,
    });

    const found = discoverBrowsers({
      roots: { applicationsRoots: [root] },
      platform: "darwin",
    });

    // Windows cannot represent POSIX execute bits, so its access check is an
    // existence check. The bundle layout is still exercised on that host.
    if (process.platform === "win32") {
      expect(found.map((entry) => entry.executablePath)).toEqual([
        path.join(
          root,
          "Google Chrome.app",
          "Contents",
          "MacOS",
          "Google Chrome",
        ),
      ]);
    } else {
      expect(found).toEqual([]);
    }
  });

  it("rejects a bundle entry that is not a file", () => {
    const root = makeRoot();
    const executable = path.join(
      root,
      "Google Chrome.app",
      "Contents",
      "MacOS",
      "Google Chrome",
    );
    mkdirSync(executable, { recursive: true });

    expect(
      inspectExecutable(executable, "test", undefined, "darwin"),
    ).toBeUndefined();
  });

  it("ignores a missing bundle executable", () => {
    const root = makeRoot();
    const missing = path.join(
      root,
      "Google Chrome.app",
      "Contents",
      "MacOS",
      "Google Chrome",
    );

    expect(
      inspectExecutable(missing, "test", undefined, "darwin"),
    ).toBeUndefined();
  });

  it("ignores an applications root that does not exist", () => {
    expect(
      discoverBrowsers({
        roots: { applicationsRoots: [path.join(makeRoot(), "missing")] },
        platform: "darwin",
      }),
    ).toEqual([]);
  });

  it("ignores an empty applications root", () => {
    expect(
      discoverBrowsers({
        roots: { applicationsRoots: [""] },
        platform: "darwin",
      }),
    ).toEqual([]);
  });

  it("reports an unknown version when the bundle carries none", () => {
    const root = makeRoot();
    const executable = installMacChrome(root, "Google Chrome.app", undefined);

    const browser = inspectExecutable(executable, "test", undefined, "darwin");

    expect(browser?.version).toBe("unknown");
  });

  it("ignores unrelated entries in the Frameworks directory", () => {
    const root = makeRoot();
    const executable = installMacChrome(
      root,
      "Google Chrome.app",
      "156.0.8078.48",
    );
    mkdirSync(
      path.join(root, "Google Chrome.app", "Contents", "Frameworks", "README"),
      { recursive: true },
    );

    const browser = inspectExecutable(executable, "test", undefined, "darwin");

    expect(browser?.version).toBe("156.0.8078.48");
  });

  it("returns no version for a path outside an app bundle", () => {
    expect(
      versionFromMacBundle(path.join(makeRoot(), "Google Chrome")),
    ).toBeUndefined();
  });
});

describe("version helpers", () => {
  it("reads a version only from a four-part install directory", () => {
    expect(
      versionFromInstallPath(
        "C:\\Chrome\\Application\\1.2.3.4\\chrome.exe",
        "win32",
      ),
    ).toBe("1.2.3.4");
    expect(
      versionFromInstallPath("C:\\Chrome\\Application\\chrome.exe", "win32"),
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
    expect(
      inspectExecutable(launcher, "explicit", undefined, "win32")?.version,
    ).toBe("156.0.8078.48");
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

    const found = discoverBrowsers({
      roots: { programFiles },
      platform: "win32",
    });
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
