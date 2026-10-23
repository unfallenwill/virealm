import { describe, expect, it } from "vitest";

import { DesktopLog, redactMessage } from "../../src/main/logging.js";

describe("DesktopLog", () => {
  it("keeps newest entries within the limit and filters by environment", () => {
    let now = 0;
    const log = new DesktopLog(() => {
      now += 1;
      return now;
    }, 3);
    log.info("a", "one", "env-1");
    log.warn("b", "two");
    log.error("c", "three", "env-2");
    log.info("d", "four", "env-1");

    expect(log.list().map((entry) => entry.code)).toEqual(["b", "c", "d"]);
    expect(log.list("env-1").map((entry) => entry.code)).toEqual(["b", "d"]);
    expect(log.list("env-2").map((entry) => entry.code)).toEqual(["b", "c"]);
  });

  it("redacts credentials and debugger paths on the way in", () => {
    const log = new DesktopLog();
    log.info(
      "test",
      "connect wss://127.0.0.1:9222/devtools/browser/abc123?token=x authorization: Bearer abc cookie=session=1",
    );
    const message = log.list()[0]?.message ?? "";
    expect(message).toContain("/devtools/browser/[redacted]");
    expect(message).not.toContain("abc123");
    expect(message).toContain("authorization=[redacted]");
    expect(message).toContain("cookie=[redacted]");
  });
});

describe("redactMessage", () => {
  it.each([
    [
      "ws://host:9222/devtools/browser/deadbeef",
      "ws://host:9222/devtools/browser/[redacted]",
    ],
    ["Authorization: Bearer abc", "Authorization=[redacted]"],
    ["authorization: Basic dXNlcjpwYXNz", "authorization=[redacted]"],
    ["access_token=abc123", "access_token=[redacted]"],
    ["password: hunter2", "password=[redacted]"],
    ["token 0123456789abcdef0123456789abcdef", "token [redacted]"],
  ])("redacts %s", (input, output) => {
    expect(redactMessage(input)).toBe(output);
  });

  it("keeps ordinary diagnostic text intact", () => {
    const text = "Chrome 156 已启动（PID 4242），profile C:\\data";
    expect(redactMessage(text)).toBe(text);
  });
});
