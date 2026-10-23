import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertDirectoryWritable,
  isDefaultChromeProfilePath,
  isPathInside,
  prepareProfile,
  readProfileMarker,
  resolveProfileLayout,
} from "../../src/chrome/profile.js";
import { BrowserAdapterError } from "../../src/domain/errors.js";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "virealm-profile-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const now = (): number => 1_700_000_000_000;

describe("resolveProfileLayout", () => {
  it("derives the profile from the environment id, not the display name", () => {
    const root = makeRoot();
    const layout = resolveProfileLayout(root, "env_a", undefined);
    expect(layout.environmentRoot).toBe(
      path.join(root, "environments", "env_a"),
    );
    expect(layout.userDataDir).toBe(
      path.join(root, "environments", "env_a", "chrome-data"),
    );
  });

  it("accepts an override inside the data root", () => {
    const root = makeRoot();
    const override = path.join(root, "custom", "profile");
    expect(resolveProfileLayout(root, "env_a", override).userDataDir).toBe(
      override,
    );
  });

  it("rejects an override outside the data root", () => {
    const root = makeRoot();
    const outside = path.join(tmpdir(), "virealm-outside-profile");
    expect(() => resolveProfileLayout(root, "env_a", outside)).toThrow(
      BrowserAdapterError,
    );
  });
});

describe("path helpers", () => {
  it("recognises descendants case-insensitively", () => {
    expect(isPathInside("C:\\Root", "C:\\Root\\Child")).toBe(true);
    expect(isPathInside("C:\\Root", "C:\\Root")).toBe(true);
    expect(isPathInside("C:\\Root", "C:\\Other")).toBe(false);
  });

  it("detects Chrome's default profile roots", () => {
    const localAppData = "C:\\Users\\tester\\AppData\\Local";
    expect(
      isDefaultChromeProfilePath(
        path.join(localAppData, "Google", "Chrome", "User Data"),
        localAppData,
      ),
    ).toBe(true);
    expect(
      isDefaultChromeProfilePath(
        path.join(localAppData, "Chromium", "User Data", "Profile 1"),
        localAppData,
      ),
    ).toBe(true);
    expect(
      isDefaultChromeProfilePath("C:\\VirealmData\\env_a", localAppData),
    ).toBe(false);
    expect(
      isDefaultChromeProfilePath("C:\\VirealmData\\env_a", undefined),
    ).toBe(false);
  });
});

describe("prepareProfile", () => {
  it("creates a marker and removes a stale DevToolsActivePort", () => {
    const root = makeRoot();
    const layout = resolveProfileLayout(root, "env_a", undefined);
    prepareProfile(layout, "env_a", now);
    writeFileSync(
      path.join(layout.userDataDir, "DevToolsActivePort"),
      "1234\n/devtools/browser/stale\n",
    );

    const marker = prepareProfile(layout, "env_a", now);
    expect(marker.environmentId).toBe("env_a");
    expect(marker.createdAtUnixMs).toBe(now());
    expect(
      existsSync(path.join(layout.userDataDir, "DevToolsActivePort")),
    ).toBe(false);
    expect(readProfileMarker(layout.userDataDir)?.environmentId).toBe("env_a");
  });

  it("is idempotent for the same environment and preserves profile data", () => {
    const root = makeRoot();
    const layout = resolveProfileLayout(root, "env_a", undefined);
    prepareProfile(layout, "env_a", now);
    const dataFile = path.join(layout.userDataDir, "Cookies");
    writeFileSync(dataFile, "profile-data");

    const second = prepareProfile(layout, "env_a", () => now() + 1);
    expect(second.createdAtUnixMs).toBe(now());
    expect(readFileSync(dataFile, "utf8")).toBe("profile-data");
  });

  it("refuses a directory owned by another environment", () => {
    const root = makeRoot();
    const layout = resolveProfileLayout(root, "env_a", undefined);
    prepareProfile(layout, "env_a", now);
    expect(() => prepareProfile(layout, "env_b", now)).toThrow(
      /different environment/,
    );
  });

  it("refuses a non-empty directory that Virealm did not create", () => {
    const root = makeRoot();
    const layout = resolveProfileLayout(root, "env_a", undefined);
    mkdirSync(layout.userDataDir, { recursive: true });
    writeFileSync(path.join(layout.userDataDir, "Cookies"), "foreign");
    expect(() => prepareProfile(layout, "env_a", now)).toThrow(
      /did not create/,
    );
  });

  it("treats a file at the profile path as a conflict", () => {
    const root = makeRoot();
    const layout = resolveProfileLayout(root, "env_a", undefined);
    mkdirSync(layout.environmentRoot, { recursive: true });
    writeFileSync(layout.userDataDir, "not a directory");
    expect(() => prepareProfile(layout, "env_a", now)).toThrow(
      BrowserAdapterError,
    );
  });

  it("reports a corrupted marker instead of overwriting it", () => {
    const root = makeRoot();
    const layout = resolveProfileLayout(root, "env_a", undefined);
    prepareProfile(layout, "env_a", now);
    writeFileSync(
      path.join(layout.userDataDir, "virealm-profile.json"),
      "{not json",
    );
    expect(() => prepareProfile(layout, "env_a", now)).toThrow(
      /not valid JSON/,
    );
    expect(() => readProfileMarker(layout.userDataDir)).toThrow(
      /not valid JSON/,
    );
  });

  it("reports a marker with an unsupported shape", () => {
    const root = makeRoot();
    const layout = resolveProfileLayout(root, "env_a", undefined);
    prepareProfile(layout, "env_a", now);
    writeFileSync(
      path.join(layout.userDataDir, "virealm-profile.json"),
      JSON.stringify({ version: 99 }),
    );
    expect(() => prepareProfile(layout, "env_a", now)).toThrow(
      /unsupported shape/,
    );
  });
});

describe("assertDirectoryWritable", () => {
  it("accepts a writable profile directory", () => {
    const root = makeRoot();
    const layout = resolveProfileLayout(root, "env_a", undefined);
    prepareProfile(layout, "env_a", now);
    expect(() => {
      assertDirectoryWritable(layout);
    }).not.toThrow();
  });

  it("rejects an unwritable profile path", () => {
    const root = makeRoot();
    const layout = {
      environmentRoot: root,
      userDataDir: path.join(root, "missing", "deep"),
    };
    expect(() => {
      assertDirectoryWritable(layout);
    }).toThrow(/not writable/);
  });
});
