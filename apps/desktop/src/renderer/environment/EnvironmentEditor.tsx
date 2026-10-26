import {
  useEffect,
  useId,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
  type SyntheticEvent,
} from "react";

import type {
  BrowserInfo,
  EnvironmentDraft,
  EnvironmentView,
  IsolationCapabilityView,
  IsolationMode,
  RuntimeStatusView,
  ValidationIssueView,
} from "../../shared/contracts.js";
import {
  parseEnvironmentDraft,
  type ValidationIssue,
} from "../../shared/validation.js";
import {
  browserIncompatibleDetail,
  browserIncompatibleIsolation,
  isBrowserCompatibleIsolation,
  isMacosPlatform,
  supportsResourceLimits,
} from "../../shared/isolation.js";
import { errorCopy, isApiError, unwrap } from "../lib/api.js";
import { issueText } from "../lib/validation-copy.js";
import { Button } from "../components/Button.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { Drawer } from "../components/Drawer.js";
import { Icon } from "../components/Icon.js";
import { InlineAlert } from "../components/InlineAlert.js";

interface FormState {
  readonly name: string;
  readonly browserMode: "auto" | "manual";
  readonly browserPath: string;
  readonly timezone: string;
  readonly locale: string;
  readonly viewportEnabled: boolean;
  readonly width: string;
  readonly height: string;
  readonly scale: string;
  readonly geolocationEnabled: boolean;
  readonly latitude: string;
  readonly longitude: string;
  readonly accuracy: string;
  readonly isolation: IsolationMode;
  readonly maxProcesses: string;
  readonly memoryMiB: string;
  readonly extraArguments: string;
}

interface IsolationCopy {
  readonly title: string;
  readonly hint: string;
}

const WINDOWS_ISOLATION_COPY: Readonly<Record<IsolationMode, IsolationCopy>> = {
  managed: {
    title: "Job Object 管理",
    hint: "由本地运行时把 Chrome 进程树纳入 Job Object，应用退出时可完整停止受管进程。",
  },
  restricted: {
    title: "受限令牌",
    hint: "以降低权限的令牌启动进程。Chromium 的浏览器进程无法在被限制的令牌下启动自己的沙箱，因此不适用于 Chrome。",
  },
  app_container: {
    title: "AppContainer",
    hint: "使用 AppContainer 与目录 ACL 限制文件与网络访问。Chromium 的浏览器进程无法在容器令牌下启动自己的沙箱，因此不适用于 Chrome。",
  },
};

const MACOS_ISOLATION_COPY: Readonly<Record<IsolationMode, IsolationCopy>> = {
  managed: {
    title: "进程组管理",
    hint: "由本地运行时把 Chrome 及其受管子进程放进同一 POSIX 进程组，停止或退出时终止整组。它不是文件或网络沙箱。",
  },
  restricted: {
    title: "受限令牌",
    hint: "macOS 不提供受限令牌隔离；该模式只能在 Windows 上使用，运行时不会模拟或降级。",
  },
  app_container: {
    title: "AppContainer",
    hint: "macOS 不提供 AppContainer 隔离；该模式只能在 Windows 上使用，运行时不会模拟或降级。",
  },
};

function isolationCopy(
  platformOs: string | undefined,
): typeof WINDOWS_ISOLATION_COPY {
  return isMacosPlatform(platformOs)
    ? MACOS_ISOLATION_COPY
    : WINDOWS_ISOLATION_COPY;
}

const COMMON_TIMEZONES = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Australia/Sydney",
];

const COMMON_LOCALES = [
  "zh-CN",
  "zh-HK",
  "zh-TW",
  "en-US",
  "en-GB",
  "ja-JP",
  "ko-KR",
  "de-DE",
  "fr-FR",
  "es-ES",
  "pt-BR",
  "ru-RU",
];

export interface EnvironmentEditorProps {
  readonly mode: "create" | "edit";
  readonly environment: EnvironmentView | undefined;
  readonly runtime: RuntimeStatusView | undefined;
  readonly defaultBrowserPath: string | undefined;
  readonly onRequestClose: () => void;
  readonly onSubmit: (draft: EnvironmentDraft) => Promise<void>;
}

export function EnvironmentEditor({
  mode,
  environment,
  runtime,
  defaultBrowserPath,
  onRequestClose,
  onSubmit,
}: EnvironmentEditorProps): JSX.Element {
  const formId = useId();
  const platformOs = runtime?.platform?.os;
  const macos = isMacosPlatform(platformOs);
  const copies = isolationCopy(platformOs);
  const limitsSupported = supportsResourceLimits(platformOs);
  const incompatible = browserIncompatibleIsolation();
  const initial = useMemo(
    () => initialState(environment, defaultBrowserPath),
    [environment, defaultBrowserPath],
  );
  const baseline = useMemo(
    () => JSON.stringify(toDraft(initial, platformOs)),
    [initial, platformOs],
  );
  const [form, setForm] = useState<FormState>(initial);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [serverIssues, setServerIssues] = useState<
    readonly ValidationIssueView[]
  >([]);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [browsers, setBrowsers] = useState<readonly BrowserInfo[]>([]);
  const [browserError, setBrowserError] = useState<string | undefined>(
    undefined,
  );

  useEffect(() => {
    let cancelled = false;
    void unwrap(window.virealm.discoverBrowsers())
      .then((found) => {
        if (!cancelled) {
          setBrowsers(found);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBrowserError(errorCopy(error).detail);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const draft = useMemo(() => toDraft(form, platformOs), [form, platformOs]);
  const parsed = useMemo(() => parseEnvironmentDraft(draft), [draft]);

  const localIssues = useMemo<readonly ValidationIssue[]>(() => {
    const issues: ValidationIssue[] = [];
    if (form.browserMode === "manual" && form.browserPath.trim().length === 0) {
      issues.push({
        path: "browser.executablePath",
        code: "required",
        message: "请选择或输入 Chrome 可执行文件的路径。",
      });
    }
    return issues;
  }, [form.browserMode, form.browserPath]);

  const issues = useMemo<readonly ValidationIssueView[]>(() => {
    const all: ValidationIssueView[] = [
      ...(parsed.ok ? [] : parsed.issues),
      ...localIssues,
      ...serverIssues,
    ];
    const seen = new Set<string>();
    return all.filter((issue) => {
      const key = `${issue.path}:${issue.code}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }, [parsed, localIssues, serverIssues]);

  const dirty = JSON.stringify(draft) !== baseline;
  const unsupportedIsolation = unsupportedIsolationModes(runtime);

  const update = <K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaveError(undefined);
    setServerIssues([]);
  };

  const touch = (path: string): void => {
    setTouched((current) => {
      const next = new Set(current);
      next.add(path);
      return next;
    });
  };

  const visibleError = (path: string): string | undefined => {
    const issue = issues.find(
      (entry) => entry.path === path || entry.path.startsWith(`${path}.`),
    );
    if (issue === undefined) {
      return undefined;
    }
    const shouldShow =
      attempted ||
      serverIssues.length > 0 ||
      [...touched].some(
        (entry) => entry === path || path.startsWith(`${entry}.`),
      );
    return shouldShow ? issueText(issue) : undefined;
  };

  const canSubmit = parsed.ok && localIssues.length === 0;

  const requestClose = (): void => {
    if (saving) {
      return;
    }
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onRequestClose();
  };

  const submit = async (): Promise<void> => {
    setAttempted(true);
    if (!canSubmit || saving) {
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    setServerIssues([]);
    try {
      await onSubmit(draft);
    } catch (error) {
      const copy = errorCopy(error);
      setSaveError(copy.detail);
      if (isApiError(error)) {
        setServerIssues(error.issues);
      }
    } finally {
      setSaving(false);
    }
  };

  const onFormSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submit();
  };

  return (
    <>
      <Drawer
        title={
          mode === "create" ? "新建环境" : `编辑 ${environment?.name ?? "环境"}`
        }
        subtitle={environment?.id}
        wide
        onRequestClose={requestClose}
        footer={
          <>
            <div className="form-summary">
              <span>{form.timezone.trim() || "系统时区"}</span>
              <span aria-hidden="true">·</span>
              <span>{form.locale.trim() || "系统语言"}</span>
              <span aria-hidden="true">·</span>
              <span>
                {form.viewportEnabled
                  ? `${form.width || "?"}×${form.height || "?"}`
                  : "窗口默认"}
              </span>
              <span aria-hidden="true">·</span>
              <span>{copies[form.isolation].title}</span>
            </div>
            <Button onClick={requestClose} disabled={saving}>
              取消
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              loading={saving}
              icon={mode === "create" ? "plus" : "check"}
            >
              {mode === "create" ? "创建环境" : "保存更改"}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          noValidate
          onSubmit={onFormSubmit}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
        >
          {mode === "edit" && environment?.state === "running" ? (
            <InlineAlert tone="info" title="环境正在运行">
              保存后，时区、语言、视口与地理位置的变更会尝试立即应用并验证；需要重启的字段会标记为“待重启”，不会中断当前浏览器。
            </InlineAlert>
          ) : null}

          {saveError === undefined ? null : (
            <InlineAlert tone="danger" title="保存失败" className="form-issues">
              {saveError}
            </InlineAlert>
          )}

          {attempted && issues.length > 0 ? (
            <InlineAlert
              tone="danger"
              title="请检查以下配置"
              className="form-issues"
            >
              还有 {issues.length} 个字段需要修正。输入内容已保留。
            </InlineAlert>
          ) : null}

          <section className="form-section">
            <div className="form-section__head">
              <div>
                <h2 className="form-section__title">基本信息</h2>
                <p className="form-section__hint">
                  名称用于区分环境；ID 由应用生成，创建后保持不变。
                </p>
              </div>
            </div>
            <div className="form-grid">
              <div className="field field--full">
                <label className="field__label" htmlFor={`${formId}-name`}>
                  环境名称
                </label>
                <input
                  id={`${formId}-name`}
                  data-autofocus
                  className="input"
                  value={form.name}
                  placeholder="例如：华东测试环境"
                  maxLength={128}
                  aria-invalid={visibleError("name") !== undefined}
                  onChange={(event) => {
                    update("name", event.target.value);
                  }}
                  onBlur={() => {
                    touch("name");
                  }}
                />
                <FieldError message={visibleError("name")} />
              </div>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section__head">
              <div>
                <h2 className="form-section__title">Chrome 浏览器</h2>
                <p className="form-section__hint">
                  浏览器启动始终通过 Browser
                  Adapter，不经过桌面应用自行拼装启动命令。
                </p>
              </div>
            </div>
            <div
              className="choice-grid"
              role="radiogroup"
              aria-label="Chrome 选择方式"
            >
              <Choice
                checked={form.browserMode === "auto"}
                title="自动发现"
                hint="使用标准安装目录中找到的最新 Chrome。升级 Chrome 后会在下次启动时使用新版本。"
                onSelect={() => {
                  update("browserMode", "auto");
                }}
              />
              <Choice
                checked={form.browserMode === "manual"}
                title="指定 Chrome 可执行文件"
                hint="固定使用某个 Chrome 可执行文件，适合多版本或便携版。"
                onSelect={() => {
                  update("browserMode", "manual");
                }}
              />
            </div>

            {form.browserMode === "manual" ? (
              <div className="field" style={{ marginTop: 12 }}>
                <label className="field__label" htmlFor={`${formId}-browser`}>
                  Chrome 可执行文件
                </label>
                <div className="input-group">
                  <input
                    id={`${formId}-browser`}
                    className="input mono"
                    value={form.browserPath}
                    placeholder={
                      macos
                        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                        : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
                    }
                    spellCheck={false}
                    aria-invalid={
                      visibleError("browser.executablePath") !== undefined
                    }
                    onChange={(event) => {
                      update("browserPath", event.target.value);
                    }}
                    onBlur={() => {
                      touch("browser.executablePath");
                    }}
                  />
                </div>
                <FieldError message={visibleError("browser.executablePath")} />
                {browsers.length > 0 ? (
                  <div className="field__hint">
                    已发现：
                    {browsers.map((browser) => (
                      <button
                        key={browser.executablePath}
                        type="button"
                        className="section__action"
                        style={{ marginLeft: 8 }}
                        title={browser.executablePath}
                        onClick={() => {
                          update("browserPath", browser.executablePath);
                        }}
                      >
                        Chrome {browser.version}
                      </button>
                    ))}
                  </div>
                ) : browserError === undefined ? (
                  <div className="field__hint">正在查找已安装的 Chrome…</div>
                ) : (
                  <div className="field__hint">
                    自动发现失败：{browserError}。仍可手动输入路径。
                  </div>
                )}
              </div>
            ) : null}

            {runtime?.available === false ? (
              <InlineAlert
                tone="warning"
                title="本地运行时不可用"
                className="verify-stale"
              >
                环境可以保存，但无法启动
                Chrome。可在“运行时”页面查看原因并重试。
              </InlineAlert>
            ) : null}
          </section>

          <section className="form-section">
            <div className="form-section__head">
              <div>
                <h2 className="form-section__title">区域与页面</h2>
                <p className="form-section__hint">
                  这些配置由 Browser Adapter 下发到
                  Chrome。留空表示跟随系统，不会伪造不存在的能力。
                </p>
              </div>
            </div>
            <div className="form-grid">
              <div className="field">
                <label className="field__label" htmlFor={`${formId}-timezone`}>
                  时区
                  <span className="field__optional">可选</span>
                </label>
                <input
                  id={`${formId}-timezone`}
                  className="input mono"
                  list={`${formId}-timezones`}
                  value={form.timezone}
                  placeholder="系统默认"
                  spellCheck={false}
                  aria-invalid={visibleError("timezone") !== undefined}
                  onChange={(event) => {
                    update("timezone", event.target.value);
                  }}
                  onBlur={() => {
                    touch("timezone");
                  }}
                />
                <datalist id={`${formId}-timezones`}>
                  {timezoneOptions().map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
                <FieldError message={visibleError("timezone")} />
              </div>

              <div className="field">
                <label className="field__label" htmlFor={`${formId}-locale`}>
                  语言
                  <span className="field__optional">可选</span>
                </label>
                <input
                  id={`${formId}-locale`}
                  className="input mono"
                  list={`${formId}-locales`}
                  value={form.locale}
                  placeholder="系统默认"
                  spellCheck={false}
                  aria-invalid={visibleError("locale") !== undefined}
                  onChange={(event) => {
                    update("locale", event.target.value);
                  }}
                  onBlur={() => {
                    touch("locale");
                  }}
                />
                <datalist id={`${formId}-locales`}>
                  {COMMON_LOCALES.map((locale) => (
                    <option key={locale} value={locale} />
                  ))}
                </datalist>
                <FieldError message={visibleError("locale")} />
              </div>

              <div className="field field--full">
                <div className="switch-row">
                  <div className="switch-row__text">
                    <div className="switch-row__title">覆盖页面视口</div>
                    <div className="switch-row__hint">
                      固定初始页面尺寸并可通过 CDP
                      验证。关闭时使用浏览器窗口默认尺寸。
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={form.viewportEnabled}
                    aria-label="覆盖页面视口"
                    className="switch"
                    onClick={() => {
                      update("viewportEnabled", !form.viewportEnabled);
                    }}
                  />
                </div>
                {form.viewportEnabled ? (
                  <div className="form-grid" style={{ marginTop: 10 }}>
                    <div className="field">
                      <label
                        className="field__label"
                        htmlFor={`${formId}-width`}
                      >
                        宽度
                      </label>
                      <input
                        id={`${formId}-width`}
                        className="input"
                        type="number"
                        inputMode="numeric"
                        min={320}
                        max={7680}
                        value={form.width}
                        aria-invalid={
                          visibleError("viewport.width") !== undefined
                        }
                        onChange={(event) => {
                          update("width", event.target.value);
                        }}
                        onBlur={() => {
                          touch("viewport");
                        }}
                      />
                      <FieldError message={visibleError("viewport.width")} />
                    </div>
                    <div className="field">
                      <label
                        className="field__label"
                        htmlFor={`${formId}-height`}
                      >
                        高度
                      </label>
                      <input
                        id={`${formId}-height`}
                        className="input"
                        type="number"
                        inputMode="numeric"
                        min={200}
                        max={4320}
                        value={form.height}
                        aria-invalid={
                          visibleError("viewport.height") !== undefined
                        }
                        onChange={(event) => {
                          update("height", event.target.value);
                        }}
                        onBlur={() => {
                          touch("viewport");
                        }}
                      />
                      <FieldError message={visibleError("viewport.height")} />
                    </div>
                    <div className="field">
                      <label
                        className="field__label"
                        htmlFor={`${formId}-scale`}
                      >
                        设备像素比
                        <span className="field__optional">可选</span>
                      </label>
                      <input
                        id={`${formId}-scale`}
                        className="input"
                        type="number"
                        inputMode="decimal"
                        min={0.5}
                        max={4}
                        step={0.25}
                        value={form.scale}
                        placeholder="1"
                        aria-invalid={
                          visibleError("viewport.deviceScaleFactor") !==
                          undefined
                        }
                        onChange={(event) => {
                          update("scale", event.target.value);
                        }}
                        onBlur={() => {
                          touch("viewport");
                        }}
                      />
                      <FieldError
                        message={visibleError("viewport.deviceScaleFactor")}
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="field field--full">
                <div className="switch-row">
                  <div className="switch-row__text">
                    <div className="switch-row__title">覆盖地理位置</div>
                    <div className="switch-row__hint">
                      通过浏览器权限覆盖上报坐标；页面仍需请求定位权限。不会改变
                      IP 或网络出口。
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={form.geolocationEnabled}
                    aria-label="覆盖地理位置"
                    className="switch"
                    onClick={() => {
                      update("geolocationEnabled", !form.geolocationEnabled);
                    }}
                  />
                </div>
                {form.geolocationEnabled ? (
                  <div className="form-grid" style={{ marginTop: 10 }}>
                    <div className="field">
                      <label className="field__label" htmlFor={`${formId}-lat`}>
                        纬度
                      </label>
                      <input
                        id={`${formId}-lat`}
                        className="input"
                        type="number"
                        inputMode="decimal"
                        step="any"
                        value={form.latitude}
                        placeholder="31.2304"
                        aria-invalid={
                          visibleError("geolocation.latitude") !== undefined
                        }
                        onChange={(event) => {
                          update("latitude", event.target.value);
                        }}
                        onBlur={() => {
                          touch("geolocation");
                        }}
                      />
                      <FieldError
                        message={visibleError("geolocation.latitude")}
                      />
                    </div>
                    <div className="field">
                      <label className="field__label" htmlFor={`${formId}-lon`}>
                        经度
                      </label>
                      <input
                        id={`${formId}-lon`}
                        className="input"
                        type="number"
                        inputMode="decimal"
                        step="any"
                        value={form.longitude}
                        placeholder="121.4737"
                        aria-invalid={
                          visibleError("geolocation.longitude") !== undefined
                        }
                        onChange={(event) => {
                          update("longitude", event.target.value);
                        }}
                        onBlur={() => {
                          touch("geolocation");
                        }}
                      />
                      <FieldError
                        message={visibleError("geolocation.longitude")}
                      />
                    </div>
                    <div className="field">
                      <label
                        className="field__label"
                        htmlFor={`${formId}-accuracy`}
                      >
                        精度（米）
                        <span className="field__optional">可选</span>
                      </label>
                      <input
                        id={`${formId}-accuracy`}
                        className="input"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        value={form.accuracy}
                        placeholder="100"
                        aria-invalid={
                          visibleError("geolocation.accuracy") !== undefined
                        }
                        onChange={(event) => {
                          update("accuracy", event.target.value);
                        }}
                        onBlur={() => {
                          touch("geolocation");
                        }}
                      />
                      <FieldError
                        message={visibleError("geolocation.accuracy")}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section__head">
              <div>
                <h2 className="form-section__title">运行时与隔离</h2>
                <p className="form-section__hint">
                  隔离能力由 Process Runtime
                  报告。不可用的模式会明确标注，而不是静默降级。
                </p>
              </div>
            </div>
            <div
              className="choice-grid"
              role="radiogroup"
              aria-label="隔离模式"
            >
              {(["managed", "restricted", "app_container"] as const).map(
                (mode) => {
                  const capability = capabilityFor(runtime, mode);
                  const browserIncompatible = incompatible.has(mode);
                  const disabled =
                    (browserIncompatible || unsupportedIsolation.has(mode)) &&
                    form.isolation !== mode;
                  return (
                    <Choice
                      key={mode}
                      checked={form.isolation === mode}
                      title={copies[mode].title}
                      hint={copies[mode].hint}
                      badge={
                        browserIncompatible ? (
                          <span className="badge badge--warning">
                            {macos ? "macOS 不支持" : "浏览器不兼容"}
                          </span>
                        ) : (
                          capabilityBadge(capability)
                        )
                      }
                      disabled={disabled}
                      onSelect={() => {
                        update("isolation", mode);
                      }}
                    />
                  );
                },
              )}
            </div>
            {isBrowserCompatibleIsolation(form.isolation) ? null : (
              <InlineAlert
                tone="warning"
                title="该环境当前使用的隔离模式无法启动 Chrome"
              >
                {browserIncompatibleDetail(platformOs)}
              </InlineAlert>
            )}
            <p className="form-note">
              <Icon name="shield" size={13} />
              <span>
                隔离模式只约束进程与文件边界，不能替代完整的操作系统指纹隔离，也不改变网络出口
                IP。
              </span>
            </p>

            <div className="form-grid" style={{ marginTop: 12 }}>
              <div className="field">
                <label className="field__label" htmlFor={`${formId}-processes`}>
                  进程上限
                  <span className="field__optional">可选</span>
                </label>
                <input
                  id={`${formId}-processes`}
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={512}
                  value={form.maxProcesses}
                  placeholder={limitsSupported ? "不限制" : "macOS 不支持"}
                  disabled={!limitsSupported}
                  aria-invalid={
                    visibleError("runtimePolicy.maxProcesses") !== undefined
                  }
                  onChange={(event) => {
                    update("maxProcesses", event.target.value);
                  }}
                  onBlur={() => {
                    touch("runtimePolicy");
                  }}
                />
                <FieldError
                  message={visibleError("runtimePolicy.maxProcesses")}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor={`${formId}-memory`}>
                  内存上限（MiB）
                  <span className="field__optional">可选</span>
                </label>
                <input
                  id={`${formId}-memory`}
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min={16}
                  value={form.memoryMiB}
                  placeholder={limitsSupported ? "不限制" : "macOS 不支持"}
                  disabled={!limitsSupported}
                  aria-invalid={
                    visibleError("runtimePolicy.memoryLimitBytes") !== undefined
                  }
                  onChange={(event) => {
                    update("memoryMiB", event.target.value);
                  }}
                  onBlur={() => {
                    touch("runtimePolicy");
                  }}
                />
                <FieldError
                  message={visibleError("runtimePolicy.memoryLimitBytes")}
                />
              </div>
            </div>
            {limitsSupported ? null : (
              <p className="form-note">
                <Icon name="info" size={13} />
                <span>
                  macOS
                  没有按进程树聚合的进程/内存上限原语，这两项不会写入环境配置，也不会用
                  RLIMIT 近似。
                </span>
              </p>
            )}
          </section>

          <section className="form-section">
            <div className="form-section__head">
              <div>
                <h2 className="form-section__title">高级</h2>
                <p className="form-section__hint">
                  每行一个以 -- 开头的 Chrome 参数。安全相关参数会被 Browser
                  Adapter 拒绝。
                </p>
              </div>
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${formId}-args`}>
                额外启动参数
                <span className="field__optional">可选</span>
              </label>
              <textarea
                id={`${formId}-args`}
                className="textarea"
                value={form.extraArguments}
                placeholder={
                  "--force-color-profile=srgb\n--disable-features=SomeFeature"
                }
                spellCheck={false}
                aria-invalid={
                  visibleError("launch.additionalArguments") !== undefined
                }
                onChange={(event) => {
                  update("extraArguments", event.target.value);
                }}
                onBlur={() => {
                  touch("launch.additionalArguments");
                }}
              />
              <FieldError
                message={visibleError("launch.additionalArguments")}
              />
            </div>
          </section>

          <p className="form-note">
            <Icon name="lock" size={13} />
            <span>
              保存只写入环境声明。浏览器数据目录由 Browser Adapter
              分配；删除环境时不会自动删除浏览器数据，除非你明确选择清理。
            </span>
          </p>
        </form>
      </Drawer>

      {discardOpen ? (
        <ConfirmDialog
          title="放弃未保存的更改？"
          confirmLabel="放弃更改"
          destructive
          onClose={() => {
            setDiscardOpen(false);
          }}
          onConfirm={() => {
            setDiscardOpen(false);
            onRequestClose();
          }}
        >
          <p>
            表单中有尚未保存的修改。关闭后这些修改会丢失，环境现有配置不受影响。
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function Choice({
  checked,
  title,
  hint,
  badge,
  disabled = false,
  onSelect,
}: {
  readonly checked: boolean;
  readonly title: string;
  readonly hint: string;
  readonly badge?: ReactNode;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className="choice"
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="choice__control" aria-hidden="true" />
      <span className="choice__body">
        <span className="choice__title">
          {title}
          {badge}
        </span>
        <span className="choice__hint">{hint}</span>
      </span>
    </button>
  );
}

function FieldError({
  message,
}: {
  readonly message: string | undefined;
}): JSX.Element | null {
  if (message === undefined) {
    return null;
  }
  return (
    <div className="field__error" role="alert">
      <Icon name="error" size={12} />
      <span>{message}</span>
    </div>
  );
}

function initialState(
  environment: EnvironmentView | undefined,
  defaultBrowserPath: string | undefined,
): FormState {
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const systemLocale = navigator.language;
  if (environment === undefined) {
    return {
      name: "",
      browserMode: defaultBrowserPath === undefined ? "auto" : "manual",
      browserPath: defaultBrowserPath ?? "",
      timezone: systemZone,
      locale: systemLocale,
      viewportEnabled: false,
      width: "1280",
      height: "800",
      scale: "",
      geolocationEnabled: false,
      latitude: "",
      longitude: "",
      accuracy: "",
      isolation: "managed",
      maxProcesses: "",
      memoryMiB: "",
      extraArguments: "",
    };
  }
  return {
    name: environment.name,
    browserMode:
      environment.browser.executablePath === undefined ? "auto" : "manual",
    browserPath: environment.browser.executablePath ?? "",
    timezone: environment.timezone ?? "",
    locale: environment.locale ?? "",
    viewportEnabled: environment.viewport !== undefined,
    width: String(environment.viewport?.width ?? 1280),
    height: String(environment.viewport?.height ?? 800),
    scale:
      environment.viewport?.deviceScaleFactor === undefined
        ? ""
        : String(environment.viewport.deviceScaleFactor),
    geolocationEnabled: environment.geolocation !== undefined,
    latitude:
      environment.geolocation === undefined
        ? ""
        : String(environment.geolocation.latitude),
    longitude:
      environment.geolocation === undefined
        ? ""
        : String(environment.geolocation.longitude),
    accuracy:
      environment.geolocation?.accuracy === undefined
        ? ""
        : String(environment.geolocation.accuracy),
    isolation: environment.runtimePolicy.isolation,
    maxProcesses:
      environment.runtimePolicy.maxProcesses === undefined
        ? ""
        : String(environment.runtimePolicy.maxProcesses),
    memoryMiB:
      environment.runtimePolicy.memoryLimitBytes === undefined
        ? ""
        : String(
            Math.round(
              environment.runtimePolicy.memoryLimitBytes / (1024 * 1024),
            ),
          ),
    extraArguments: (environment.launch?.additionalArguments ?? []).join("\n"),
  };
}

function toDraft(
  form: FormState,
  platformOs: string | undefined,
): EnvironmentDraft {
  const timezone = form.timezone.trim();
  const locale = form.locale.trim();
  const browserPath = form.browserPath.trim();
  const capsLimits = supportsResourceLimits(platformOs);
  const maxProcesses = capsLimits
    ? optionalInteger(form.maxProcesses)
    : undefined;
  const memoryMiB = capsLimits ? optionalInteger(form.memoryMiB) : undefined;
  const width = integer(form.width);
  const height = integer(form.height);
  const scale = number(form.scale);
  const latitude = requiredNumber(form.latitude);
  const longitude = requiredNumber(form.longitude);
  const accuracy = number(form.accuracy);
  const args = form.extraArguments
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return {
    name: form.name.trim(),
    browser:
      form.browserMode === "manual" && browserPath.length > 0
        ? { executablePath: browserPath }
        : {},
    ...(timezone.length === 0 ? {} : { timezone }),
    ...(locale.length === 0 ? {} : { locale }),
    ...(form.viewportEnabled
      ? {
          viewport: {
            width,
            height,
            ...(scale === undefined ? {} : { deviceScaleFactor: scale }),
          },
        }
      : {}),
    ...(form.geolocationEnabled
      ? {
          geolocation: {
            latitude,
            longitude,
            ...(accuracy === undefined ? {} : { accuracy }),
          },
        }
      : {}),
    runtimePolicy: {
      isolation: form.isolation,
      ...(maxProcesses === undefined ? {} : { maxProcesses }),
      ...(memoryMiB === undefined
        ? {}
        : { memoryLimitBytes: memoryMiB * 1024 * 1024 }),
    },
    ...(args.length === 0 ? {} : { launch: { additionalArguments: args } }),
  };
}

/** Empty numeric inputs become NaN so shared validation reports them. */
function integer(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return Number.NaN;
  }
  return Number(trimmed);
}

function optionalInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return Number(trimmed);
}

function number(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return Number(trimmed);
}

/** Required numeric inputs become NaN so shared validation reports them. */
function requiredNumber(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return Number.NaN;
  }
  return Number(trimmed);
}

function timezoneOptions(): readonly string[] {
  try {
    const supported = Intl.supportedValuesOf("timeZone");
    const unique = new Set([...COMMON_TIMEZONES, ...supported]);
    return [...unique].sort();
  } catch {
    return COMMON_TIMEZONES;
  }
}

function unsupportedIsolationModes(
  runtime: RuntimeStatusView | undefined,
): ReadonlySet<IsolationMode> {
  if (!runtime?.available) {
    return new Set();
  }
  return new Set(
    runtime.isolation
      .filter(
        (entry) =>
          entry.state === "unsupported" || entry.state === "unavailable",
      )
      .map((entry) => entry.mode),
  );
}

function capabilityFor(
  runtime: RuntimeStatusView | undefined,
  mode: IsolationMode,
): IsolationCapabilityView | undefined {
  return runtime?.isolation.find((entry) => entry.mode === mode);
}

function capabilityBadge(
  capability: IsolationCapabilityView | undefined,
): ReactNode {
  if (capability === undefined) {
    return <span className="badge">待检测</span>;
  }
  const copy: Readonly<Record<string, string>> = {
    supported: "可用",
    unsupported: "不支持",
    unavailable: "不可用",
    not_verified: "未验证",
  };
  const tone =
    capability.state === "supported"
      ? "badge--success"
      : capability.state === "not_verified"
        ? ""
        : "badge--warning";
  return (
    <span
      className={["badge", tone].filter(Boolean).join(" ")}
      title={capability.detail}
    >
      {copy[capability.state] ?? capability.state}
    </span>
  );
}
