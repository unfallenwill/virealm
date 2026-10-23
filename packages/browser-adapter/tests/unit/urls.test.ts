import { describe, expect, it } from "vitest";

import { isNavigableUrl } from "../../src/domain/urls.js";

describe("isNavigableUrl", () => {
  it.each([
    "about:blank",
    "http://127.0.0.1:8080/",
    "https://example.test/page?x=1",
  ])("accepts %s", (url) => {
    expect(isNavigableUrl(url)).toBe(true);
  });

  it.each([
    "",
    "not a url",
    "file:///C:/Windows/System32/",
    "javascript:alert(1)",
    "data:text/html,hello",
    "chrome://settings",
    "ftp://127.0.0.1/",
  ])("rejects %s", (url) => {
    expect(isNavigableUrl(url)).toBe(false);
  });
});
