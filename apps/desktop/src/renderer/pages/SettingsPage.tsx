import { useEffect, useState, type JSX } from "react";

import type {
  AppInfoView,
  AppSettingsView,
  BrowserInfo,
  ThemePreference,
} from "../../shared/contracts.js";
import { Button, IconButton } from "../components/Button.js";
import { Icon } from "../components/Icon.js";
import { InlineAlert } from "../components/InlineAlert.js";
import { PageHeader } from "../components/PageHeader.js";
import { errorCopy, unwrap } from "../lib/api.js";
import { copyText } from "../lib/format.js";

const THEMES: readonly {
  readonly value: ThemePreference;
  readonly label: string;
  readonly icon: "moon" | "sun" | "laptop";
}[] = [
  { value: "dark", label: "深色", icon: "moon" },
  { value: "light", label: "浅色", icon: "sun" },
  { value: "system", label: "跟随系统", icon: "laptop" },
];

export interface SettingsPageProps {
  readonly settings: AppSettingsView | undefined;
  readonly appInfo: AppInfoView | undefined;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onThemeChange: (theme: ThemePreference) => void;
  readonly onDefaultBrowserChange: (path: string | undefined) => void;
  readonly onOpenRuntime: () => void;
}

export function SettingsPage({
  settings,
  appInfo,
  busy,
  error,
  onThemeChange,
  onDefaultBrowserChange,
  onOpenRuntime,
}: SettingsPageProps): JSX.Element {
  const [browserDraft, setBrowserDraft] = useState(
    settings?.defaultBrowserPath ?? "",
  );
  const [browsers, setBrowsers] = useState<readonly BrowserInfo[]>([]);
  const [browserDiscoveryError, setBrowserDiscoveryError] = useState<
    string | undefined
  >(undefined);
  const [copied, setCopied] = useState<string | undefined>(undefined);

  useEffect(() => {
    setBrowserDraft(settings?.defaultBrowserPath ?? "");
  }, [settings?.defaultBrowserPath]);

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
          setBrowserDiscoveryError(errorCopy(error).detail);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const savedPath = settings?.defaultBrowserPath ?? "";
  const normalizedDraft = browserDraft.trim();
  const browserDirty = normalizedDraft !== savedPath;

  const copy = async (key: string, value: string): Promise<void> => {
    if (await copyText(value)) {
      setCopied(key);
      window.setTimeout(() => {
        setCopied((current) => (current === key ? undefined : current));
      }, 1600);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="设置"
        description="外观和默认浏览器会保存在本机。只展示桌面应用真正支持的设置，其他行为以只读方式说明。"
        actions={
          <Button icon="activity" onClick={onOpenRuntime}>
            运行时与诊断
          </Button>
        }
      />

      {error === undefined ? null : (
        <InlineAlert tone="danger" title="设置未保存">
          {error}
        </InlineAlert>
      )}

      <section className="settings-section">
        <div className="panel">
          <div className="panel__header">
            <h2 className="panel__title">外观</h2>
          </div>
          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">主题</div>
              <p className="setting-row__desc">
                深色是默认主题。选择“跟随系统”时，窗口会随 Windows 的
                应用主题切换，不改变系统设置。
              </p>
            </div>
            <div className="setting-row__control">
              <div className="theme-choice" role="group" aria-label="主题">
                {THEMES.map((theme) => (
                  <button
                    key={theme.value}
                    type="button"
                    className="theme-choice__item"
                    aria-pressed={settings?.theme === theme.value}
                    disabled={busy || settings === undefined}
                    onClick={() => {
                      onThemeChange(theme.value);
                    }}
                  >
                    <Icon name={theme.icon} size={13} />
                    {theme.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="panel">
          <div className="panel__header">
            <h2 className="panel__title">浏览器</h2>
          </div>
          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">新建环境的默认 Chrome</div>
              <p className="setting-row__desc">
                新建环境时预填此路径。留空表示自动发现标准安装目录中最新 的
                Chrome。已有环境仍使用各自保存的选择。
              </p>
              {browsers.length > 0 ? (
                <div className="field__hint" style={{ marginTop: 6 }}>
                  已发现：
                  {browsers.map((browser) => (
                    <button
                      key={browser.executablePath}
                      type="button"
                      className="section__action"
                      style={{ marginLeft: 8 }}
                      title={browser.executablePath}
                      onClick={() => {
                        setBrowserDraft(browser.executablePath);
                      }}
                    >
                      Chrome {browser.version}
                    </button>
                  ))}
                </div>
              ) : browserDiscoveryError === undefined ? (
                <div className="field__hint" style={{ marginTop: 6 }}>
                  正在查找已安装的 Chrome…
                </div>
              ) : (
                <div className="field__hint" style={{ marginTop: 6 }}>
                  自动发现失败：{browserDiscoveryError}
                </div>
              )}
            </div>
            <div className="setting-row__control setting-row__control--wide">
              <div style={{ width: "100%" }}>
                <input
                  className="input mono"
                  value={browserDraft}
                  placeholder="自动发现"
                  spellCheck={false}
                  aria-label="默认 Chrome 可执行文件路径"
                  disabled={busy}
                  onChange={(event) => {
                    setBrowserDraft(event.target.value);
                  }}
                />
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    marginTop: 8,
                    justifyContent: "flex-end",
                  }}
                >
                  {savedPath.length > 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        onDefaultBrowserChange(undefined);
                      }}
                    >
                      恢复自动发现
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy}
                    disabled={!browserDirty}
                    onClick={() => {
                      onDefaultBrowserChange(
                        normalizedDraft.length === 0
                          ? undefined
                          : normalizedDraft,
                      );
                    }}
                  >
                    保存路径
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="panel">
          <div className="panel__header">
            <h2 className="panel__title">数据与生命周期</h2>
          </div>
          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">数据根目录</div>
              <p className="setting-row__desc">
                环境元数据、设置以及各环境的 Chrome
                数据都位于此目录。暂不提供修改入口，避免破坏已存在的 Profile
                路径。清理环境数据必须针对单个环境明确确认。
              </p>
            </div>
            <div className="setting-row__control setting-row__control--wide">
              <div className="copy-line" style={{ width: "100%" }}>
                <span
                  className="mono"
                  style={{ fontSize: 10.5, color: "var(--text-secondary)" }}
                  title={appInfo?.dataRoot}
                >
                  {appInfo?.dataRoot ?? "加载中…"}
                </span>
                <IconButton
                  icon={copied === "dataRoot" ? "check" : "copy"}
                  label="复制数据根目录"
                  size={12}
                  disabled={appInfo === undefined}
                  onClick={() => {
                    if (appInfo !== undefined) {
                      void copy("dataRoot", appInfo.dataRoot);
                    }
                  }}
                />
              </div>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">启动行为</div>
              <p className="setting-row__desc">
                应用启动时只恢复环境列表，不会自动启动任何
                Chrome。环境状态始终在打开列表时重新查询。
              </p>
            </div>
            <div className="setting-row__control">
              <span className="badge">不自动启动</span>
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">退出行为</div>
              <p className="setting-row__desc">
                退出应用时会先优雅停止由本应用启动且仍在运行的环境，再关闭运行时和本地探测服务。浏览器数据目录会保留。
              </p>
            </div>
            <div className="setting-row__control">
              <span className="badge">停止受管环境</span>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="panel">
          <div className="panel__header">
            <h2 className="panel__title">日志与诊断</h2>
          </div>
          <div className="setting-row">
            <div className="setting-row__text">
              <div className="setting-row__title">本地诊断</div>
              <p className="setting-row__desc">
                运行时、环境状态和能力报告都在本机读取。每个环境的详情页可以复制脱敏诊断信息；日志不会写入
                Cookie、密码或访问令牌。
              </p>
            </div>
            <div className="setting-row__control">
              <Button
                size="sm"
                variant="secondary"
                icon="activity"
                onClick={onOpenRuntime}
              >
                打开运行时
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="panel">
          <div className="panel__header">
            <h2 className="panel__title">关于 Virealm</h2>
            <span className="badge badge--mono">{appInfo?.version ?? "—"}</span>
          </div>
          <div className="about-grid">
            <About label="应用版本" value={appInfo?.version} />
            <About label="Electron" value={appInfo?.electronVersion} />
            <About label="Chrome" value={appInfo?.chromeVersion} />
            <About label="运行时" value={appInfo?.runtimeExecutable} />
            <About label="用户数据" value={appInfo?.userDataDir} />
            <About label="环境数据根" value={appInfo?.dataRoot} />
          </div>
          <div className="panel__body" style={{ paddingTop: 0 }}>
            <p className="form-note" style={{ marginTop: 0 }}>
              <Icon name="info" size={13} />
              <span>
                本地桌面
                MVP。不包含账户、云同步、远程浏览器、计费或插件市场。浏览器启动通过
                Browser Adapter，桌面应用不复制其启动逻辑。
              </span>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function About({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | undefined;
}): JSX.Element {
  return (
    <div className="about-item">
      <div className="about-item__label">{label}</div>
      <div className="about-item__value">{value ?? "—"}</div>
    </div>
  );
}
