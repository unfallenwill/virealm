import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { VIREALM_SCHEMA_ID, virealmSchema } from "../src/index.js";
import { loadManifest, readFixture } from "./helpers/fixtures.js";

function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs);
    }
    return refs;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") {
        refs.push(child);
      } else {
        collectRefs(child, refs);
      }
    }
  }
  return refs;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateMessage = ajv.compile(virealmSchema);
const manifest = loadManifest();

describe("bundled schema", () => {
  it("is a valid Draft 2020-12 schema", () => {
    expect(ajv.validateSchema(virealmSchema)).toBe(true);
    expect(virealmSchema.$id).toBe(VIREALM_SCHEMA_ID);
  });

  it("contains only internal definition references", () => {
    const refs = collectRefs(virealmSchema);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toMatch(/^#\/\$defs\/[A-Za-z][A-Za-z0-9]*$/);
    }
  });

  it("does not leak the generation manifest", () => {
    expect(virealmSchema).not.toHaveProperty("x-include");
  });

  it("accepts every valid fixture", () => {
    for (const { file } of manifest.valid) {
      expect(validateMessage(readFixture(file)), file).toBe(true);
    }
  });
});
