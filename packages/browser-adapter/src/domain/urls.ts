/**
 * URLs the adapter may hand to Chrome. Remote debugging is never exposed to a
 * page, and only ordinary browser schemes are accepted so configuration cannot
 * smuggle a `file:` or `javascript:` target into a launch.
 */
export function isNavigableUrl(value: string): boolean {
  if (value === "about:blank") {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
