import { get } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  startProbeServer,
  type ProbeServer,
} from "../../src/main/runtime/probe-server.js";

let server: ProbeServer | undefined;

function rawGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      response.on("error", reject);
    }).on("error", reject);
  });
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("startProbeServer", () => {
  it("echoes the Accept-Language header over loopback only", async () => {
    server = await startProbeServer();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/accept-language$/u);

    const response = await fetch(server.url, {
      headers: { "Accept-Language": "zh-CN,zh;q=0.9" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      acceptLanguage: "zh-CN,zh;q=0.9",
    });
  });

  it("returns an empty string when the header is absent", async () => {
    server = await startProbeServer();
    const body = await rawGet(server.url);
    expect(JSON.parse(body) as unknown).toEqual({ acceptLanguage: "" });
  });

  it("rejects other paths and methods", async () => {
    server = await startProbeServer();
    const origin = new URL(server.url).origin;

    const missing = await fetch(`${origin}/other`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    const post = await fetch(server.url, { method: "POST" });
    expect(post.status).toBe(404);
  });

  it("stops accepting connections after close", async () => {
    const local = await startProbeServer();
    await local.close();
    await expect(fetch(local.url)).rejects.toThrow();
  });
});
