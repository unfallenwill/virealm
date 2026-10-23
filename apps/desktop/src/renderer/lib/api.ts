import type {
  IpcErrorView,
  IpcResult,
  ValidationIssueView,
} from "../../shared/contracts.js";

export class ApiError extends Error {
  readonly code: string;
  readonly issues: readonly ValidationIssueView[];
  readonly details:
    Readonly<Record<string, string | number | boolean>> | undefined;

  constructor(view: IpcErrorView) {
    super(view.message);
    this.name = "ApiError";
    this.code = view.code;
    this.issues = view.issues ?? [];
    this.details = view.details;
  }
}

export async function unwrap<T>(result: Promise<IpcResult<T>>): Promise<T> {
  const response = await result;
  if (!response.ok) {
    throw new ApiError(response.error);
  }
  return response.data;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

const ERROR_TITLES: Readonly<Record<string, string>> = {
  runtime_unavailable: "本地运行时不可用",
  runtime_not_started: "本地运行时未启动",
  runtime_ipc_failure: "运行时通信失败",
  runtime_operation_failed: "运行时操作失败",
  chrome_not_found: "未找到可用的 Chrome",
  chrome_incompatible: "Chrome 版本不匹配",
  invalid_configuration: "环境配置无效",
  invalid_request: "请求无效",
  data_directory_conflict: "数据目录冲突",
  data_cleanup_refused: "已拒绝清理数据目录",
  data_cleanup_failed: "清理数据目录失败",
  profile_corrupted: "浏览器配置目录损坏",
  launch_failed: "无法启动 Chrome",
  environment_busy: "环境正忙",
  environment_running: "环境仍在运行",
  environment_not_running: "环境未运行",
  environment_not_found: "环境不存在",
  environment_already_running: "环境已在运行",
  environment_exists: "环境已存在",
  environment_restart_required: "需要重启环境",
  unsupported_isolation: "不支持所选隔离模式",
  cdp_timeout: "连接浏览器超时",
  cdp_disconnected: "浏览器调试连接已断开",
  browser_exited: "Chrome 已退出",
  config_apply_failed: "配置应用失败",
  config_verification_failed: "配置验证未通过",
  persistence_failed: "保存失败",
  persistence_incompatible: "数据版本不兼容",
  target_not_found: "目标页面不存在",
  internal_error: "操作失败",
};

export interface ErrorCopy {
  readonly title: string;
  readonly detail: string;
}

export function errorCopy(error: unknown): ErrorCopy {
  if (isApiError(error)) {
    const title = ERROR_TITLES[error.code] ?? "操作失败";
    const detail =
      error.issues.length > 0
        ? error.issues
            .slice(0, 3)
            .map((issue) => issue.message)
            .join("；")
        : error.message;
    return { title, detail };
  }
  if (error instanceof Error) {
    return { title: "操作失败", detail: error.message };
  }
  return { title: "操作失败", detail: "发生未知错误。" };
}
