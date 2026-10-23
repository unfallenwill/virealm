import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";

import type {
  AppInfoView,
  AppSettingsView,
  DiagnosticsView,
  EnvironmentDraft,
  EnvironmentView,
  RuntimeStatusView,
  ThemePreference,
} from "../shared/contracts.js";
import { AppShell } from "./components/AppShell.js";
import { ConfirmDialog } from "./components/ConfirmDialog.js";
import type {
  BusyAction,
  EnvironmentActions,
} from "./components/EnvironmentRow.js";
import { Sidebar, type ViewName } from "./components/Sidebar.js";
import { Toasts, type ToastItem, type ToastTone } from "./components/Toasts.js";
import {
  EnvironmentDetails,
  type DetailTab,
} from "./environment/EnvironmentDetails.js";
import { EnvironmentEditor } from "./environment/EnvironmentEditor.js";
import { errorCopy, unwrap } from "./lib/api.js";
import { EnvironmentsPage } from "./pages/EnvironmentsPage.js";
import { RuntimePage } from "./pages/RuntimePage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

type EditorState =
  { readonly mode: "create" } | { readonly mode: "edit"; readonly id: string };

interface DetailState {
  readonly id: string;
  readonly tab: DetailTab;
}

interface DeleteState {
  readonly id: string;
  readonly name: string;
}

interface ForceStopState {
  readonly id: string;
  readonly name: string;
}

export function App(): JSX.Element {
  const [view, setView] = useState<ViewName>("environments");
  const [environments, setEnvironments] = useState<readonly EnvironmentView[]>(
    [],
  );
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | undefined>(undefined);
  const [runtime, setRuntime] = useState<RuntimeStatusView | undefined>(
    undefined,
  );
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeActionError, setRuntimeActionError] = useState<
    string | undefined
  >(undefined);
  const [appInfo, setAppInfo] = useState<AppInfoView | undefined>(undefined);
  const [settings, setSettings] = useState<AppSettingsView | undefined>(
    undefined,
  );
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | undefined>(
    undefined,
  );
  const [busyById, setBusyById] = useState<
    Readonly<Record<string, BusyAction | undefined>>
  >({});
  const [errorsById, setErrorsById] = useState<
    Readonly<Record<string, string | undefined>>
  >({});
  const [editor, setEditor] = useState<EditorState | undefined>(undefined);
  const [detail, setDetail] = useState<DetailState | undefined>(undefined);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsView | undefined>(
    undefined,
  );
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | undefined>(
    undefined,
  );
  const [deleteTarget, setDeleteTarget] = useState<DeleteState | undefined>();
  const [deleteData, setDeleteData] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  const [forceTarget, setForceTarget] = useState<ForceStopState | undefined>();
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);

  const environmentRef = useRef<readonly EnvironmentView[]>([]);
  environmentRef.current = environments;
  const toastId = useRef(0);
  const diagnosticsRequest = useRef(0);

  const dismissToast = useCallback((id: number): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const addToast = useCallback(
    (tone: ToastTone, title: string, detail?: string): void => {
      toastId.current += 1;
      const id = toastId.current;
      setToasts((current) => [
        ...current.slice(-3),
        {
          id,
          tone,
          title,
          ...(detail === undefined ? {} : { detail }),
        },
      ]);
      window.setTimeout(
        () => {
          dismissToast(id);
        },
        tone === "error" ? 8000 : 4500,
      );
    },
    [dismissToast],
  );

  const replaceEnvironment = useCallback((updated: EnvironmentView): void => {
    setEnvironments((current) =>
      current.map((environment) =>
        environment.id === updated.id ? updated : environment,
      ),
    );
  }, []);

  const refreshEnvironments = useCallback(
    async (options?: {
      readonly loading?: boolean;
      readonly quiet?: boolean;
    }): Promise<void> => {
      const loading = options?.loading === true;
      if (loading) {
        setListLoading(true);
      }
      try {
        const data = await unwrap(window.virealm.listEnvironments());
        setEnvironments(data);
        setListError(undefined);
      } catch (error) {
        const copy = errorCopy(error);
        if (options?.quiet !== true || environmentRef.current.length === 0) {
          setListError(copy.detail);
        }
      } finally {
        if (loading) {
          setListLoading(false);
        }
      }
    },
    [],
  );

  const refreshRuntime = useCallback(async (quiet = false): Promise<void> => {
    try {
      const status = await unwrap(window.virealm.runtimeStatus());
      setRuntime(status);
      if (quiet) {
        setRuntimeActionError(undefined);
      }
    } catch (error) {
      if (!quiet) {
        const copy = errorCopy(error);
        setRuntime((current) => ({
          available: false,
          pipePath: current?.pipePath ?? "—",
          executablePath: current?.executablePath,
          error: { code: "runtime_status_failed", message: copy.detail },
          platform: current?.platform,
          isolation: current?.isolation ?? [],
          checkedAtUnixMs: Date.now(),
        }));
      }
    }
  }, []);

  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      setSettings(await unwrap(window.virealm.getSettings()));
    } catch (error) {
      const copy = errorCopy(error);
      setSettingsError(copy.detail);
    }
  }, []);

  const loadAppInfo = useCallback(async (): Promise<void> => {
    try {
      setAppInfo(await unwrap(window.virealm.appInfo()));
    } catch {
      // About information is optional; the rest of the app remains usable.
    }
  }, []);

  useEffect(() => {
    void refreshEnvironments({ loading: true });
    void refreshRuntime();
    void loadSettings();
    void loadAppInfo();
  }, [refreshEnvironments, refreshRuntime, loadSettings, loadAppInfo]);

  useEffect(() => {
    let listInFlight = false;
    let runtimeInFlight = false;
    let tick = 0;
    const run = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      if (!listInFlight) {
        listInFlight = true;
        void refreshEnvironments({ quiet: true }).finally(() => {
          listInFlight = false;
        });
      }
      tick += 1;
      if (tick % 2 === 0 && !runtimeInFlight) {
        runtimeInFlight = true;
        void refreshRuntime(true).finally(() => {
          runtimeInFlight = false;
        });
      }
    };
    const timer = window.setInterval(run, 3000);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") {
        run();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refreshEnvironments, refreshRuntime]);

  // Theme is applied from persisted preferences; system is resolved live.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const preference: ThemePreference = settings?.theme ?? "dark";
      const effective =
        preference === "system"
          ? media.matches
            ? "dark"
            : "light"
          : preference;
      document.documentElement.dataset.theme = effective;
    };
    apply();
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
    };
  }, [settings?.theme]);

  useEffect(() => {
    document.querySelector<HTMLElement>("#main-content")?.scrollTo({ top: 0 });
  }, [view]);

  const runOperation = useCallback(
    async (
      id: string,
      action: BusyAction,
      operation: () => Promise<void>,
    ): Promise<boolean> => {
      setBusyById((current) => ({ ...current, [id]: action }));
      setErrorsById((current) => ({ ...current, [id]: undefined }));
      try {
        await operation();
        return true;
      } catch (error) {
        const copy = errorCopy(error);
        setErrorsById((current) => ({ ...current, [id]: copy.detail }));
        addToast("error", copy.title, copy.detail);
        return false;
      } finally {
        setBusyById((current) => ({ ...current, [id]: undefined }));
      }
    },
    [addToast],
  );

  const launch = useCallback(
    (environment: EnvironmentView): void => {
      void runOperation(environment.id, "launch", async () => {
        const updated = await unwrap(
          window.virealm.launchEnvironment(environment.id),
        );
        replaceEnvironment(updated);
        addToast(
          "success",
          `“${environment.name}”已启动`,
          updated.browserVersion === undefined
            ? "Chrome 已通过 Browser Adapter 启动。"
            : `Chrome ${updated.browserVersion}`,
        );
        await refreshEnvironments({ quiet: true });
      });
    },
    [addToast, refreshEnvironments, replaceEnvironment, runOperation],
  );

  const stop = useCallback(
    (environment: EnvironmentView, force: boolean): void => {
      void runOperation(environment.id, "stop", async () => {
        const updated = await unwrap(
          window.virealm.stopEnvironment(environment.id, { force }),
        );
        replaceEnvironment(updated);
        addToast(
          "success",
          force
            ? `已强制停止“${environment.name}”`
            : `已停止“${environment.name}”`,
          "受管 Chrome 进程已退出，浏览器数据保留在环境目录中。",
        );
        await refreshEnvironments({ quiet: true });
      });
    },
    [addToast, refreshEnvironments, replaceEnvironment, runOperation],
  );

  const restart = useCallback(
    (environment: EnvironmentView): void => {
      void runOperation(environment.id, "restart", async () => {
        await unwrap(
          window.virealm.stopEnvironment(environment.id, { force: false }),
        );
        const updated = await unwrap(
          window.virealm.launchEnvironment(environment.id),
        );
        replaceEnvironment(updated);
        addToast(
          "success",
          `“${environment.name}”已重启`,
          updated.pendingRestart
            ? "配置仍在等待下次重启生效。"
            : "已使用保存的配置重新启动 Chrome。",
        );
        await refreshEnvironments({ quiet: true });
      });
    },
    [addToast, refreshEnvironments, replaceEnvironment, runOperation],
  );

  const verify = useCallback(
    (environment: EnvironmentView): void => {
      void runOperation(environment.id, "verify", async () => {
        const updated = await unwrap(
          window.virealm.verifyEnvironment(environment.id),
        );
        replaceEnvironment(updated);
        const fields = updated.verification?.fields ?? [];
        const verified = fields.filter(
          (field) => field.status === "verified",
        ).length;
        const failed = fields.filter(
          (field) => field.status === "failed",
        ).length;
        const unsupported = fields.filter(
          (field) => field.status === "unsupported",
        ).length;
        const tone: ToastTone = failed > 0 ? "warning" : "success";
        addToast(
          tone,
          failed > 0 ? "配置验证有未通过项" : "配置验证完成",
          [
            `${String(verified)} 项已验证`,
            failed > 0 ? `${String(failed)} 项失败` : undefined,
            unsupported > 0 ? `${String(unsupported)} 项不支持` : undefined,
          ]
            .filter((part): part is string => part !== undefined)
            .join(" · "),
        );
        setDiagnostics(undefined);
        setDetail({ id: environment.id, tab: "verification" });
        await refreshEnvironments({ quiet: true });
      });
    },
    [addToast, refreshEnvironments, replaceEnvironment, runOperation],
  );

  const openDetails = useCallback(
    (environment: EnvironmentView, tab: DetailTab): void => {
      setDiagnostics(undefined);
      setDiagnosticsError(undefined);
      setDetail({ id: environment.id, tab });
    },
    [],
  );

  const requestDelete = useCallback((environment: EnvironmentView): void => {
    setDeleteError(undefined);
    setDeleteData(false);
    setDeleteTarget({ id: environment.id, name: environment.name });
  }, []);

  const confirmDelete = useCallback((): void => {
    if (deleteTarget === undefined) {
      return;
    }
    const target = deleteTarget;
    void runOperation(target.id, "delete", async () => {
      await unwrap(
        window.virealm.removeEnvironment(target.id, {
          deleteData,
        }),
      );
      setDeleteTarget(undefined);
      setDeleteError(undefined);
      if (detail?.id === target.id) {
        setDetail(undefined);
        setDiagnostics(undefined);
      }
      addToast(
        "success",
        `已删除“${target.name}”`,
        deleteData
          ? "环境记录与浏览器数据目录已清理。"
          : "环境记录已删除，浏览器数据目录保留在本机。",
      );
      await refreshEnvironments({ quiet: true });
    }).then((ok) => {
      if (!ok) {
        setDeleteError("未能删除环境。请查看通知中的原因后重试。");
      }
    });
  }, [
    addToast,
    deleteData,
    deleteTarget,
    detail?.id,
    refreshEnvironments,
    runOperation,
  ]);

  const requestForceStop = useCallback((environment: EnvironmentView): void => {
    setForceTarget({ id: environment.id, name: environment.name });
  }, []);

  const confirmForceStop = useCallback((): void => {
    if (forceTarget === undefined) {
      return;
    }
    const environment = environmentRef.current.find(
      (entry) => entry.id === forceTarget.id,
    );
    if (environment === undefined) {
      setForceTarget(undefined);
      return;
    }
    void runOperation(forceTarget.id, "stop", async () => {
      const updated = await unwrap(
        window.virealm.stopEnvironment(forceTarget.id, { force: true }),
      );
      replaceEnvironment(updated);
      setForceTarget(undefined);
      addToast(
        "success",
        `已强制停止“${forceTarget.name}”`,
        "未再等待 Chrome 自行退出。浏览器数据保留。",
      );
      await refreshEnvironments({ quiet: true });
    });
  }, [
    addToast,
    forceTarget,
    refreshEnvironments,
    replaceEnvironment,
    runOperation,
  ]);

  const loadDiagnostics = useCallback(async (id: string): Promise<void> => {
    diagnosticsRequest.current += 1;
    const request = diagnosticsRequest.current;
    setDiagnosticsLoading(true);
    setDiagnosticsError(undefined);
    try {
      const data = await unwrap(window.virealm.environmentDiagnostics(id));
      if (request === diagnosticsRequest.current) {
        setDiagnostics(data);
      }
    } catch (error) {
      if (request === diagnosticsRequest.current) {
        setDiagnosticsError(errorCopy(error).detail);
      }
    } finally {
      if (request === diagnosticsRequest.current) {
        setDiagnosticsLoading(false);
      }
    }
  }, []);

  const refreshDiagnostics = useCallback((): void => {
    if (detail !== undefined) {
      void loadDiagnostics(detail.id);
    }
  }, [detail, loadDiagnostics]);

  const createEnvironment = useCallback(
    async (draft: EnvironmentDraft): Promise<void> => {
      const created = await unwrap(window.virealm.createEnvironment(draft));
      addToast(
        "success",
        `已创建“${created.name}”`,
        "环境尚未启动。启动后才会占用 Chrome 数据目录。",
      );
      setEditor(undefined);
      await refreshEnvironments({ quiet: true });
    },
    [addToast, refreshEnvironments],
  );

  const updateEnvironment = useCallback(
    async (draft: EnvironmentDraft): Promise<void> => {
      if (editor?.mode !== "edit") {
        return;
      }
      const result = await unwrap(
        window.virealm.updateEnvironment(editor.id, draft),
      );
      replaceEnvironment(result.environment);
      if (result.restartFields.length > 0) {
        addToast("info", "配置已保存，部分修改待重启", result.message);
      } else {
        addToast("success", "配置已保存", result.message);
      }
      setEditor(undefined);
      await refreshEnvironments({ quiet: true });
    },
    [addToast, editor, refreshEnvironments, replaceEnvironment],
  );

  const updateSettings = useCallback(
    async (
      patch: {
        readonly theme?: ThemePreference;
        readonly defaultBrowserPath?: string | undefined;
      },
      successMessage: string,
    ): Promise<void> => {
      setSettingsBusy(true);
      setSettingsError(undefined);
      try {
        const updated = await unwrap(window.virealm.updateSettings(patch));
        setSettings(updated);
        addToast("success", successMessage);
      } catch (error) {
        const copy = errorCopy(error);
        setSettingsError(copy.detail);
        addToast("error", copy.title, copy.detail);
      } finally {
        setSettingsBusy(false);
      }
    },
    [addToast],
  );

  const retryRuntime = useCallback((): void => {
    setRuntimeBusy(true);
    setRuntimeActionError(undefined);
    void unwrap(window.virealm.restartRuntime())
      .then(async (status) => {
        setRuntime(status);
        addToast(
          status.available ? "success" : "warning",
          status.available ? "本地运行时已连接" : "本地运行时仍不可用",
          status.error?.message,
        );
        await refreshEnvironments({ quiet: true });
      })
      .catch((error: unknown) => {
        const copy = errorCopy(error);
        setRuntimeActionError(copy.detail);
        addToast("error", copy.title, copy.detail);
      })
      .finally(() => {
        setRuntimeBusy(false);
      });
  }, [addToast, refreshEnvironments]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const overlayOpen =
        editor !== undefined ||
        detail !== undefined ||
        deleteTarget !== undefined ||
        forceTarget !== undefined;
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.key.toLowerCase() === "n" && !overlayOpen) {
          event.preventDefault();
          setView("environments");
          setEditor({ mode: "create" });
          return;
        }
        if (event.key === "," && !overlayOpen) {
          event.preventDefault();
          setView("settings");
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [deleteTarget, detail, editor, forceTarget]);

  useEffect(() => {
    if (editor?.mode === "edit" && !listLoading) {
      if (!environments.some((environment) => environment.id === editor.id)) {
        setEditor(undefined);
      }
    }
  }, [editor, environments, listLoading]);

  useEffect(() => {
    if (detail !== undefined && !listLoading) {
      if (!environments.some((environment) => environment.id === detail.id)) {
        setDetail(undefined);
      }
    }
  }, [detail, environments, listLoading]);

  const environmentActions = useMemo<EnvironmentActions>(
    () => ({
      onOpen: (environment) => {
        openDetails(environment, "overview");
      },
      onEdit: (environment) => {
        setDetail(undefined);
        setEditor({ mode: "edit", id: environment.id });
      },
      onLaunch: (environment) => {
        launch(environment);
      },
      onStop: (environment) => {
        stop(environment, false);
      },
      onRestart: (environment) => {
        restart(environment);
      },
      onForceStop: (environment) => {
        requestForceStop(environment);
      },
      onVerify: (environment) => {
        verify(environment);
      },
      onDelete: (environment) => {
        requestDelete(environment);
      },
      onShowDiagnostics: (environment) => {
        openDetails(environment, "diagnostics");
      },
      onDismissError: (id) => {
        setErrorsById((current) => ({ ...current, [id]: undefined }));
      },
    }),
    [
      launch,
      openDetails,
      requestDelete,
      requestForceStop,
      restart,
      stop,
      verify,
    ],
  );

  const editingEnvironment =
    editor?.mode === "edit"
      ? environments.find((environment) => environment.id === editor.id)
      : undefined;

  const detailEnvironment =
    detail === undefined
      ? undefined
      : environments.find((environment) => environment.id === detail.id);

  const detailDiagnostics =
    diagnostics !== undefined && diagnostics.environment.id === detail?.id
      ? diagnostics
      : undefined;

  return (
    <>
      <AppShell
        sidebar={
          <Sidebar
            view={view}
            environmentCount={environments.length}
            runtime={runtime}
            onNavigate={setView}
          />
        }
      >
        {view === "environments" ? (
          <EnvironmentsPage
            loading={listLoading}
            loadError={listError}
            environments={environments}
            runtime={runtime}
            busyById={busyById}
            errorsById={errorsById}
            actions={environmentActions}
            onCreate={() => {
              setEditor({ mode: "create" });
            }}
            onRetry={() => {
              void refreshEnvironments({ loading: true });
            }}
            onShowRuntime={() => {
              setView("runtime");
            }}
          />
        ) : null}
        {view === "runtime" ? (
          <RuntimePage
            runtime={runtime}
            busy={runtimeBusy}
            actionError={runtimeActionError}
            onRetry={retryRuntime}
          />
        ) : null}
        {view === "settings" ? (
          <SettingsPage
            settings={settings}
            appInfo={appInfo}
            busy={settingsBusy}
            error={settingsError}
            onThemeChange={(theme) => {
              void updateSettings({ theme }, "主题已更新");
            }}
            onDefaultBrowserChange={(path) => {
              void updateSettings(
                { defaultBrowserPath: path },
                path === undefined
                  ? "已恢复自动发现 Chrome"
                  : "默认 Chrome 已保存",
              );
            }}
            onOpenRuntime={() => {
              setView("runtime");
            }}
          />
        ) : null}
      </AppShell>

      {editor !== undefined ? (
        editor.mode === "create" || editingEnvironment !== undefined ? (
          <EnvironmentEditor
            key={editor.mode === "edit" ? editor.id : "create"}
            mode={editor.mode}
            environment={editingEnvironment}
            runtime={runtime}
            defaultBrowserPath={settings?.defaultBrowserPath}
            onRequestClose={() => {
              setEditor(undefined);
            }}
            onSubmit={
              editor.mode === "create" ? createEnvironment : updateEnvironment
            }
          />
        ) : null
      ) : null}

      {detail !== undefined && detailEnvironment !== undefined ? (
        <EnvironmentDetails
          environment={detailEnvironment}
          runtime={runtime}
          busy={busyById[detailEnvironment.id]}
          initialTab={detail.tab}
          diagnostics={detailDiagnostics}
          diagnosticsLoading={diagnosticsLoading}
          diagnosticsError={diagnosticsError}
          onRefreshDiagnostics={refreshDiagnostics}
          onRequestClose={() => {
            setDetail(undefined);
            setDiagnostics(undefined);
          }}
          onEdit={() => {
            setDetail(undefined);
            setDiagnostics(undefined);
            setEditor({ mode: "edit", id: detailEnvironment.id });
          }}
          onLaunch={() => {
            launch(detailEnvironment);
          }}
          onStop={() => {
            stop(detailEnvironment, false);
          }}
          onRestart={() => {
            restart(detailEnvironment);
          }}
          onVerify={() => {
            verify(detailEnvironment);
          }}
          onDelete={() => {
            requestDelete(detailEnvironment);
          }}
          onShowRuntime={() => {
            setDetail(undefined);
            setView("runtime");
          }}
        />
      ) : null}

      {deleteTarget !== undefined ? (
        <ConfirmDialog
          title={`删除“${deleteTarget.name}”？`}
          confirmLabel={deleteData ? "删除环境与数据" : "删除环境"}
          destructive
          busy={busyById[deleteTarget.id] === "delete"}
          onClose={() => {
            if (busyById[deleteTarget.id] !== "delete") {
              setDeleteTarget(undefined);
              setDeleteError(undefined);
            }
          }}
          onConfirm={confirmDelete}
        >
          <p>
            环境记录会从本机移除。此操作不会影响其他环境。正在运行的环境必须先停止，当前操作会被拒绝。
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={deleteData}
              onChange={(event) => {
                setDeleteData(event.target.checked);
              }}
            />
            <span className="checkbox__text">
              <strong>同时删除浏览器数据</strong>
              仅删除由 Browser Adapter 为本环境分配的 Chrome
              数据目录。此目录中的 Cookie、登录状态和缓存将永久丢失，无法恢复。
            </span>
          </label>
          {deleteError === undefined ? null : (
            <p style={{ marginTop: 12, color: "var(--danger)", fontSize: 12 }}>
              {deleteError}
            </p>
          )}
        </ConfirmDialog>
      ) : null}

      {forceTarget !== undefined ? (
        <ConfirmDialog
          title={`强制停止“${forceTarget.name}”？`}
          confirmLabel="强制停止"
          destructive
          busy={busyById[forceTarget.id] === "stop"}
          onClose={() => {
            if (busyById[forceTarget.id] !== "stop") {
              setForceTarget(undefined);
            }
          }}
          onConfirm={confirmForceStop}
        >
          <p>
            强制停止会跳过等待 Chrome
            自行退出的阶段，按现有策略结束受管进程。未保存的页面状态可能丢失，浏览器数据目录不会被删除。
          </p>
          <p style={{ color: "var(--text-tertiary)", fontSize: 12 }}>
            普通“停止”会先请求浏览器退出，并确认受管进程已经结束。
          </p>
        </ConfirmDialog>
      ) : null}

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
