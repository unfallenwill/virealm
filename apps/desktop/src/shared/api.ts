import type {
  AppInfoView,
  AppSettingsView,
  BrowserInfo,
  DiagnosticsView,
  EnvironmentDraft,
  EnvironmentMutationResult,
  EnvironmentView,
  IpcResult,
  RuntimeStatusView,
  ThemePreference,
} from "./contracts.js";

export interface SettingsPatch {
  readonly theme?: ThemePreference;
  readonly defaultBrowserPath?: string | undefined;
}

/**
 * The complete preload surface. There is deliberately no generic invoke,
 * no filesystem method and no process access: every capability is a named,
 * validated operation.
 */
export interface DesktopApi {
  listEnvironments(): Promise<IpcResult<readonly EnvironmentView[]>>;
  getEnvironment(id: string): Promise<IpcResult<EnvironmentView>>;
  createEnvironment(
    draft: EnvironmentDraft,
  ): Promise<IpcResult<EnvironmentView>>;
  updateEnvironment(
    id: string,
    draft: EnvironmentDraft,
  ): Promise<IpcResult<EnvironmentMutationResult>>;
  removeEnvironment(
    id: string,
    options: { readonly deleteData: boolean },
  ): Promise<IpcResult<{ readonly removed: true }>>;
  launchEnvironment(id: string): Promise<IpcResult<EnvironmentView>>;
  stopEnvironment(
    id: string,
    options: { readonly force: boolean },
  ): Promise<IpcResult<EnvironmentView>>;
  verifyEnvironment(id: string): Promise<IpcResult<EnvironmentView>>;
  environmentDiagnostics(id: string): Promise<IpcResult<DiagnosticsView>>;
  discoverBrowsers(): Promise<IpcResult<readonly BrowserInfo[]>>;
  runtimeStatus(): Promise<IpcResult<RuntimeStatusView>>;
  restartRuntime(): Promise<IpcResult<RuntimeStatusView>>;
  appInfo(): Promise<IpcResult<AppInfoView>>;
  getSettings(): Promise<IpcResult<AppSettingsView>>;
  updateSettings(patch: SettingsPatch): Promise<IpcResult<AppSettingsView>>;
}
