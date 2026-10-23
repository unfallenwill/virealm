import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ERROR_CODES, PROTOCOL_VERSION } from "../src/index.js";

const REPOSITORY_ROOT = new URL("../../../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, REPOSITORY_ROOT), "utf8");
}

function toSnakeCase(value: string): string {
  return value
    .replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    .slice(1);
}

describe("Rust runtime parity", () => {
  it("uses the same protocol version as virealm-process-runtime", () => {
    const match = /pub const PROTOCOL_VERSION: u32 = (\d+);/.exec(
      source("crates/process-runtime/src/lib.rs"),
    );
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(PROTOCOL_VERSION);
  });

  it("contains every runtime error category plus only protocol-level additions", () => {
    const enumBody = /pub enum ErrorCode \{([\s\S]*?)\n\}/.exec(
      source("crates/process-runtime/src/error.rs"),
    );
    const body = enumBody?.[1];
    if (body === undefined) {
      throw new Error("could not find the ErrorCode enum in the Rust runtime");
    }

    const runtimeCodes: string[] = [];
    for (const line of body.split("\n")) {
      const variant = /^\s{4}([A-Z][A-Za-z0-9]*),$/.exec(line);
      const name = variant?.[1];
      if (name !== undefined) {
        runtimeCodes.push(toSnakeCase(name));
      }
    }

    expect(runtimeCodes.length).toBeGreaterThan(0);
    for (const code of runtimeCodes) {
      expect(ERROR_CODES).toContain(code);
    }

    const protocolOnly = ERROR_CODES.filter(
      (code) => !runtimeCodes.includes(code),
    ).sort();
    expect(protocolOnly).toEqual([
      "process_not_found",
      "unknown_method",
      "unsupported_protocol_version",
    ]);
  });
});
