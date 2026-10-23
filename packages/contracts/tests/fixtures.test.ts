import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FIXTURES_ROOT,
  issueMatches,
  loadManifest,
  readFixture,
  validateFixture,
} from "./helpers/fixtures.js";

const manifest = loadManifest();

function jsonFilesIn(directory: string): string[] {
  return readdirSync(join(FIXTURES_ROOT, directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

describe("fixture index", () => {
  it("lists every valid fixture", () => {
    expect(manifest.valid.map((entry) => basename(entry.file)).sort()).toEqual(
      jsonFilesIn("valid"),
    );
  });

  it("lists every invalid fixture", () => {
    expect(
      manifest.invalid.map((entry) => basename(entry.file)).sort(),
    ).toEqual(jsonFilesIn("invalid"));
  });
});

describe("valid fixtures", () => {
  it.each(manifest.valid)("$file", ({ file, kind }) => {
    const result = validateFixture(kind, readFixture(file));
    expect(
      result.ok,
      `${file} should be valid but reported ${JSON.stringify(
        result.ok ? [] : result.issues,
      )}`,
    ).toBe(true);
  });
});

describe("invalid fixtures", () => {
  it.each(manifest.invalid)("$file", ({ file, kind, expect: expected }) => {
    const result = validateFixture(kind, readFixture(file));
    expect(result.ok, `${file} should be rejected`).toBe(false);
    if (result.ok) {
      return;
    }

    const matched = result.issues.some((issue) =>
      issueMatches(issue, expected),
    );
    expect(
      matched,
      `${file} should report ${JSON.stringify(expected)}; got ${JSON.stringify(
        result.issues,
      )}`,
    ).toBe(true);
  });
});
