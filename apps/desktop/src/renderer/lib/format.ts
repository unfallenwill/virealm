import type {
  ConfigFieldName,
  EnvironmentPhase,
  EnvironmentView,
} from "../../shared/contracts.js";

export function phaseLabel(phase: EnvironmentPhase): string {
  switch (phase) {
    case "running":
      return "运行中";
    case "starting":
      return "启动中";
    case "stopping":
      return "停止中";
    case "stopped":
      return "已停止";
    case "failed":
      return "启动失败";
    case "unknown":
      return "状态未知";
  }
}

export function phaseTone(
  phase: EnvironmentPhase,
): "success" | "warning" | "danger" | "idle" {
  switch (phase) {
    case "running":
      return "success";
    case "starting":
    case "stopping":
    case "unknown":
      return "warning";
    case "failed":
      return "danger";
    case "stopped":
      return "idle";
  }
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const fullFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatDateTime(value: number | undefined): string {
  if (value === undefined) {
    return "—";
  }
  return fullFormatter.format(new Date(value));
}

export function formatShortDateTime(value: number | undefined): string {
  if (value === undefined) {
    return "—";
  }
  return dateFormatter.format(new Date(value));
}

export function formatClock(value: number): string {
  const date = new Date(value);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function formatRelative(
  value: number | undefined,
  now = Date.now(),
): string {
  if (value === undefined) {
    return "从未";
  }
  const delta = Math.max(0, now - value);
  if (delta < 45_000) {
    return "刚刚";
  }
  if (delta < 60 * 60_000) {
    return `${String(Math.round(delta / 60_000))} 分钟前`;
  }
  if (delta < 24 * 60 * 60_000) {
    return `${String(Math.round(delta / 3_600_000))} 小时前`;
  }
  if (delta < 7 * 24 * 60 * 60_000) {
    return `${String(Math.round(delta / 86_400_000))} 天前`;
  }
  return dateFormatter.format(new Date(value));
}

export function formatBrowser(version: string | undefined): string {
  return version === undefined ? "Chrome 未知" : `Chrome ${version}`;
}

export function formatLocaleConfig(environment: EnvironmentView): string {
  const parts: string[] = [];
  if (environment.timezone !== undefined) {
    parts.push(environment.timezone);
  }
  if (environment.locale !== undefined) {
    parts.push(environment.locale.toUpperCase());
  }
  return parts.length > 0 ? parts.join(" · ") : "系统默认";
}

export function formatViewport(environment: EnvironmentView): string {
  if (environment.viewport === undefined) {
    return "窗口默认";
  }
  const scale =
    environment.viewport.deviceScaleFactor === undefined
      ? ""
      : ` @${String(environment.viewport.deviceScaleFactor)}×`;
  return `${String(environment.viewport.width)}×${String(environment.viewport.height)}${scale}`;
}

export function shortenPath(value: string, segments = 2): string {
  const normalized = value.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  if (parts.length <= segments + 1) {
    return value;
  }
  return `…${parts.slice(-segments).join("\\")}`;
}

export function formatBytes(value: number | undefined): string {
  if (value === undefined) {
    return "未限制";
  }
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit] ?? "B"}`;
}

export function fieldLabel(field: ConfigFieldName): string {
  switch (field) {
    case "timezone":
      return "时区";
    case "locale":
      return "语言";
    case "acceptLanguage":
      return "Accept-Language";
    case "viewport":
      return "页面视口";
    case "deviceScaleFactor":
      return "设备像素比";
    case "geolocation":
      return "地理位置";
  }
}

export function configValue(value: unknown): string {
  if (value === undefined) {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.width === "number" && typeof record.height === "number") {
      const screen =
        typeof record.screenWidth === "number" &&
        typeof record.screenHeight === "number"
          ? ` · 屏幕 ${String(record.screenWidth)} × ${String(record.screenHeight)}`
          : "";
      return `${String(record.width)} × ${String(record.height)}${screen}`;
    }
    if (typeof record.language === "string") {
      const languages = Array.isArray(record.languages)
        ? (record.languages as unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          )
        : typeof record.languages === "string"
          ? record.languages.split(",").map((entry) => entry.trim())
          : [];
      const list = languages.filter((entry) => entry.length > 0).join(", ");
      return list.length === 0
        ? record.language
        : `${record.language} · ${list}`;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

export function isolationLabel(mode: string): string {
  switch (mode) {
    case "managed":
      return "Job Object 包含";
    case "restricted":
      return "受限令牌";
    case "app_container":
      return "AppContainer";
    default:
      return mode;
  }
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
