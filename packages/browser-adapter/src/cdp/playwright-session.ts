import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";

import type {
  BrowserConnectorPort,
  BrowserPagePort,
  BrowserSessionPort,
  CdpSessionPort,
} from "../application/ports.js";
import { BrowserAdapterError } from "../domain/errors.js";

/**
 * Playwright is used only as a mature CDP transport and page plumbing layer.
 * No Playwright type crosses this module's public boundary.
 */
export class PlaywrightBrowserConnector implements BrowserConnectorPort {
  async connect(
    endpoint: string,
    timeoutMs: number,
  ): Promise<BrowserSessionPort> {
    try {
      const browser = await chromium.connectOverCDP(endpoint, {
        timeout: timeoutMs,
      });
      return new PlaywrightBrowserSession(browser);
    } catch (error) {
      throw new BrowserAdapterError(
        "cdp_timeout",
        "connecting to Chrome over CDP failed",
        { endpoint: redactEndpoint(endpoint), timeoutMs },
        error,
      );
    }
  }
}

class PlaywrightBrowserSession implements BrowserSessionPort {
  private readonly browser: Browser;
  private readonly pagePorts = new WeakMap<Page, PlaywrightPagePort>();
  private nextPageId = 1;
  private browserSession: CDPSession | undefined;

  constructor(browser: Browser) {
    this.browser = browser;
  }

  version(): string {
    return this.browser.version();
  }

  pages(): readonly BrowserPagePort[] {
    return this.browser
      .contexts()
      .flatMap((context) => context.pages())
      .map((page) => this.portFor(page));
  }

  async newPage(url: string): Promise<BrowserPagePort> {
    const context = this.browser.contexts()[0];
    if (context === undefined) {
      throw new BrowserAdapterError(
        "cdp_disconnected",
        "the connected browser has no default context",
      );
    }
    const page = await context.newPage();
    if (url.length > 0) {
      await page.goto(url);
    }
    return this.portFor(page);
  }

  onPageCreated(listener: (page: BrowserPagePort) => void): () => void {
    const handlers: {
      context: BrowserContext;
      handler: (page: Page) => void;
    }[] = [];
    for (const context of this.browser.contexts()) {
      const handler = (page: Page): void => {
        listener(this.portFor(page));
      };
      context.on("page", handler);
      handlers.push({ context, handler });
    }
    return (): void => {
      for (const { context, handler } of handlers) {
        context.off("page", handler);
      }
    };
  }

  onDisconnected(listener: () => void): () => void {
    this.browser.on("disconnected", listener);
    return (): void => {
      this.browser.off("disconnected", listener);
    };
  }

  async sendBrowserCommand(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.browserSession ??= await this.browser.newBrowserCDPSession();
    return sendRaw(this.browserSession, method, params);
  }

  async disconnect(): Promise<void> {
    try {
      await this.browser.close();
    } catch (error) {
      throw new BrowserAdapterError(
        "cdp_disconnected",
        "disconnecting the CDP connection failed",
        undefined,
        error,
      );
    }
  }

  isConnected(): boolean {
    return this.browser.isConnected();
  }

  private portFor(page: Page): PlaywrightPagePort {
    const existing = this.pagePorts.get(page);
    if (existing !== undefined) {
      return existing;
    }
    const pageId = `page-${String(this.nextPageId)}`;
    this.nextPageId += 1;
    const port = new PlaywrightPagePort(page, pageId);
    this.pagePorts.set(page, port);
    return port;
  }
}

class PlaywrightPagePort implements BrowserPagePort {
  readonly pageId: string;
  private readonly page: Page;

  constructor(page: Page, pageId: string) {
    this.page = page;
    this.pageId = pageId;
  }

  url(): string {
    return this.page.url();
  }

  async evaluate<T>(expression: string): Promise<T> {
    return this.page.evaluate<T>(expression);
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url);
  }

  async createCdpSession(): Promise<CdpSessionPort> {
    const session = await this.page.context().newCDPSession(this.page);
    return new PlaywrightCdpSession(session);
  }

  async close(): Promise<void> {
    await this.page.close();
  }
}

class PlaywrightCdpSession implements CdpSessionPort {
  private readonly session: CDPSession;

  constructor(session: CDPSession) {
    this.session = session;
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    return sendRaw(this.session, method, params);
  }

  async detach(): Promise<void> {
    await this.session.detach();
  }
}

/**
 * Playwright types `CDPSession.send` against its generated protocol map. This
 * boundary deliberately accepts method strings because the adapter's port is
 * transport-neutral, so the dynamic shape is narrowed once, here.
 */
function sendRaw(
  session: CDPSession,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const raw = session as unknown as {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  return raw.send(method, params ?? {});
}

function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "invalid endpoint";
  }
}
