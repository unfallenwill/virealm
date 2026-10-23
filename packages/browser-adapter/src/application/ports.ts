import type {
  CapabilityReport,
  LaunchParams,
  ProcessStatus,
} from "@virealm/contracts";

import type { DiscoveredBrowser } from "../domain/environment.js";
import type { PersistedRuntimeState } from "../domain/status.js";

/**
 * Process Runtime boundary. The application layer never creates an OS process
 * and never imports a platform API; it asks this port.
 */
export interface RuntimePort {
  getCapabilities(signal?: AbortSignal): Promise<CapabilityReport>;
  launch(params: LaunchParams, signal?: AbortSignal): Promise<ProcessStatus>;
  getStatus(
    processInstanceId: string,
    signal?: AbortSignal,
  ): Promise<ProcessStatus>;
  terminate(
    processInstanceId: string,
    signal?: AbortSignal,
  ): Promise<ProcessStatus>;
}

export interface CdpSessionPort {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

export interface BrowserPagePort {
  readonly pageId: string;
  url(): string;
  evaluate<T>(expression: string): Promise<T>;
  navigate(url: string): Promise<void>;
  createCdpSession(): Promise<CdpSessionPort>;
  close(): Promise<void>;
}

/**
 * Browser boundary. Everything CDP-specific lives behind this port so callers
 * and the domain never see Playwright or protocol types.
 */
export interface BrowserSessionPort {
  version(): string;
  pages(): readonly BrowserPagePort[];
  newPage(url: string): Promise<BrowserPagePort>;
  onPageCreated(listener: (page: BrowserPagePort) => void): () => void;
  onDisconnected(listener: () => void): () => void;
  sendBrowserCommand(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

export interface BrowserConnectorPort {
  connect(endpoint: string, timeoutMs: number): Promise<BrowserSessionPort>;
}

export interface ChromeDiscoveryPort {
  discover(executablePath?: string): readonly DiscoveredBrowser[];
}

export interface RuntimeStateStorePort {
  read(environmentId: string): Promise<PersistedRuntimeState | undefined>;
  list(): Promise<readonly PersistedRuntimeState[]>;
  write(state: PersistedRuntimeState): Promise<void>;
}
