import type { ValidationIssueView } from "../../shared/contracts.js";

/** Turn developer-facing validation codes into concise Chinese copy. */
export function issueText(issue: ValidationIssueView): string {
  const path = issue.path;
  if (path === "name") {
    if (issue.code === "required") {
      return "请输入环境名称。";
    }
    return "名称最多 128 个字符，且不能包含控制字符。";
  }
  if (path === "browser.executablePath") {
    return "请选择有效的 chrome.exe，或改用自动发现。";
  }
  if (path === "timezone") {
    return "请输入有效的 IANA 时区，例如 Asia/Shanghai。";
  }
  if (path === "locale") {
    return "请输入有效的 BCP-47 语言标签，例如 zh-CN。";
  }
  if (path === "viewport.width") {
    return "视口宽度需为 320–7680 之间的整数。";
  }
  if (path === "viewport.height") {
    return "视口高度需为 200–4320 之间的整数。";
  }
  if (path === "viewport.deviceScaleFactor") {
    return "像素比需在 0.5–4 之间。";
  }
  if (path === "geolocation.latitude") {
    return "纬度需在 -90–90 之间。";
  }
  if (path === "geolocation.longitude") {
    return "经度需在 -180–180 之间。";
  }
  if (path === "geolocation.accuracy") {
    return "精度需在 0–100000 米之间。";
  }
  if (path === "runtimePolicy.isolation") {
    return "请选择一种隔离模式。";
  }
  if (path === "runtimePolicy.maxProcesses") {
    return "进程上限需为 1–512 之间的整数。";
  }
  if (path === "runtimePolicy.memoryLimitBytes") {
    return "内存上限需在 16 MiB–64 GiB 之间。";
  }
  if (path.startsWith("launch.additionalArguments")) {
    return "每行一个以 -- 开头的参数，最多 32 个且不能重复。";
  }
  return issue.message;
}

export function fieldError(
  issues: readonly ValidationIssueView[],
  ...paths: readonly string[]
): string | undefined {
  const found = issues.find((issue) =>
    paths.some(
      (path) => issue.path === path || issue.path.startsWith(`${path}.`),
    ),
  );
  return found === undefined ? undefined : issueText(found);
}
