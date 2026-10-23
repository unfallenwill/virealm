import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";
import { _electron as electron } from "playwright-core";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const shotDir = path.resolve(appRoot, "..", "..", "docs", "screenshots");
await mkdir(shotDir, { recursive: true });
const userData = await mkdtemp(path.join(tmpdir(), "virealm-visual-"));

// An environment stored before Chromium's incompatibility with restricted
// tokens was confirmed. It must still load and be readable, and the interface
// has to say why it cannot be started.
await writeFile(
  path.join(userData, "environments.json"),
  `${JSON.stringify(
    {
      version: 1,
      environments: [
        {
          id: "env-legacy-restricted",
          name: "旧配置（受限令牌）",
          browser: {},
          timezone: "Asia/Shanghai",
          locale: "zh-CN",
          viewport: { width: 1440, height: 900 },
          runtimePolicy: { isolation: "restricted" },
          createdAtUnixMs: 1_000,
          updatedAtUnixMs: 1_000,
          pendingRestart: false,
          dataDir: path.join(
            userData,
            "data",
            "environments",
            "env-legacy-restricted",
            "chrome-data",
          ),
        },
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const app = await electron.launch({
  executablePath: electronPath,
  args: [appRoot],
  cwd: appRoot,
  env: {
    ...process.env,
    NODE_ENV: "production",
    VIREALM_USER_DATA_DIR: userData,
    VIREALM_RUNTIME_PATH:
      process.env.VIREALM_RUNTIME_PATH ??
      path.resolve(
        appRoot,
        "..",
        "..",
        "target",
        "debug",
        "virealm-runtime.exe",
      ),
  },
  timeout: 30_000,
});

const logs = [];
app.process().stderr?.on("data", (chunk) => logs.push(String(chunk)));
const page = await app.firstWindow();
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning") {
    logs.push(`[console.${message.type()}] ${message.text()}`);
  }
});
page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));
await page.waitForLoadState("domcontentloaded");

const windowHandle = await app.browserWindow(page);
await windowHandle.evaluate((window) => {
  window.setSize(1440, 900);
});

let shotIndex = 0;
async function shot(name) {
  shotIndex += 1;
  await page.screenshot({
    path: path.join(
      shotDir,
      `${String(shotIndex).padStart(2, "0")}-${name}.png`,
    ),
  });
  console.log(`shot ${String(shotIndex).padStart(2, "0")}: ${name}`);
}

async function stateOf(id) {
  return page.evaluate(async (environmentId) => {
    const result = await window.virealm.listEnvironments();
    if (!result.ok) {
      return { error: result.error };
    }
    const environment = result.data.find((entry) => entry.id === environmentId);
    return environment === undefined
      ? { error: "missing" }
      : {
          state: environment.state,
          verification: environment.verification?.fields?.length ?? 0,
          lastError: environment.lastError,
        };
  }, id);
}

async function waitForState(id, wanted, timeout = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const current = await stateOf(id);
    console.log("  state:", JSON.stringify(current));
    if (current.state === wanted) {
      return current;
    }
    if (current.state === "failed") {
      throw new Error(
        `environment failed: ${JSON.stringify(current.lastError)}`,
      );
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`timed out waiting for ${wanted}`);
}

try {
  await page.waitForTimeout(2500);
  await shot("empty-dark");

  await page.getByRole("button", { name: "新建环境" }).click();
  await page.waitForSelector(".drawer");
  await page.waitForTimeout(500);
  await shot("editor-top");

  await page.getByRole("button", { name: "创建环境" }).click();
  await page.waitForTimeout(300);
  await shot("editor-validation");

  await page.getByLabel("环境名称").fill("华东测试环境");
  await page.getByLabel("时区").fill("Asia/Shanghai");
  await page.getByLabel("语言").fill("zh-CN");
  await page.getByRole("switch", { name: "覆盖页面视口" }).click();
  await page.getByLabel("宽度").fill("1440");
  await page.getByLabel("高度").fill("900");
  await page.locator(".drawer__body").evaluate((element) => {
    element.scrollTo({ top: element.scrollHeight });
  });
  await page.waitForTimeout(300);
  await shot("editor-bottom");
  await page.locator(".drawer__body").evaluate((element) => {
    element.scrollTo({ top: 0 });
  });
  await page.getByRole("button", { name: "创建环境" }).click();
  await page.waitForSelector(".drawer", { state: "detached" });
  await page.waitForTimeout(600);
  await shot("list-one");

  const environments = await page.evaluate(async () => {
    const result = await window.virealm.listEnvironments();
    return result.ok
      ? result.data.map((entry) => ({ id: entry.id, name: entry.name }))
      : [];
  });
  const id = environments.find((entry) => entry.name === "华东测试环境")?.id;
  console.log("created:", JSON.stringify(environments));

  await page.getByPlaceholder("搜索名称或 ID").fill("不存在的环境");
  await page.waitForTimeout(300);
  await shot("list-no-results");
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page.waitForTimeout(300);

  await page.getByRole("button", { name: "华东测试环境 的更多操作" }).click();
  await page.waitForTimeout(300);
  await shot("row-menu");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // An environment stored with an isolation mode Chromium cannot run in. It
  // still loads and stays readable, and the interface has to say why it cannot
  // be started instead of failing with a generic runtime error.
  await page
    .getByRole("button", { name: "旧配置（受限令牌）", exact: true })
    .click();
  await page.waitForSelector(".drawer");
  await page.waitForTimeout(500);
  await shot("details-legacy-incompatible");

  await page.getByRole("tab", { name: "配置" }).click();
  await page.waitForTimeout(300);
  await shot("details-legacy-config");
  await page.getByRole("tab", { name: "概览" }).click();
  await page.waitForTimeout(250);

  await page.getByRole("button", { name: "启动环境" }).click();
  await page.waitForTimeout(1500);
  await shot("details-legacy-launch-refused");

  await page.getByRole("button", { name: "编辑配置" }).click();
  await page.waitForTimeout(500);
  await page.locator(".drawer__body").evaluate((element) => {
    element.scrollTo({ top: element.scrollHeight });
  });
  await page.waitForTimeout(300);
  await shot("editor-legacy-incompatible");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  await page.getByRole("button", { name: "华东测试环境", exact: true }).click();
  await page.waitForSelector(".drawer");
  await page.waitForTimeout(500);
  await shot("details-overview");

  await page.getByRole("tab", { name: "配置" }).click();
  await page.waitForTimeout(250);
  await shot("details-config");

  await page.getByRole("tab", { name: "验证" }).click();
  await page.waitForTimeout(250);
  await shot("details-verification-empty");

  await page.getByRole("tab", { name: "诊断" }).click();
  await page.waitForTimeout(800);
  await shot("details-diagnostics");

  await page.getByRole("button", { name: "删除" }).click();
  await page.waitForTimeout(300);
  await shot("delete-confirm");
  await page.getByRole("button", { name: "取消" }).click();
  await page.waitForTimeout(200);

  await page.getByRole("tab", { name: "概览" }).click();
  await page.getByRole("button", { name: "编辑配置" }).click();
  await page.waitForTimeout(400);
  const drawerCount = await page.locator(".drawer").count();
  console.log("drawers after edit from details:", drawerCount);
  await shot("editor-from-details");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.getByRole("button", { name: "华东测试环境", exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "启动环境" }).click();
  await waitForState(id, "running");
  await page.waitForTimeout(1800);
  await shot("details-running");

  await page.getByRole("button", { name: "验证配置" }).click();
  await page.waitForFunction(async () => {
    const result = await window.virealm.listEnvironments();
    return result.ok && (result.data[0]?.verification?.fields?.length ?? 0) > 0;
  });
  await page.waitForTimeout(1200);
  await shot("details-verified");

  await page.getByRole("tab", { name: "验证" }).click();
  await page.waitForTimeout(400);
  await shot("details-verification");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await shot("list-running");

  await page
    .getByRole("navigation")
    .getByRole("button", { name: "运行时" })
    .click();
  await page.waitForTimeout(500);
  await shot("runtime-dark");

  await page.getByTitle("设置 (Ctrl+,)").click();
  await page.waitForTimeout(500);
  await shot("settings-dark");

  await page.getByRole("button", { name: "浅色" }).click();
  await page.waitForTimeout(800);
  await shot("settings-light");

  await page
    .getByRole("navigation")
    .getByRole("button", { name: "环境" })
    .click();
  await page.waitForTimeout(500);
  await shot("list-light");

  await page.getByRole("button", { name: "华东测试环境", exact: true }).click();
  await page.waitForTimeout(500);
  await shot("details-light");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await windowHandle.evaluate((window) => {
    window.setSize(1024, 700);
  });
  await page.waitForTimeout(700);
  await shot("list-narrow-light");

  await page.getByRole("button", { name: "新建环境" }).click();
  await page.waitForTimeout(500);
  await shot("editor-narrow-light");
  await page.keyboard.press("Escape");

  await page
    .getByRole("navigation")
    .getByRole("button", { name: "运行时" })
    .click();
  await page.waitForTimeout(500);
  await shot("runtime-narrow-light");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "环境" })
    .click();
  await page.waitForTimeout(400);

  const layout = await page.evaluate(() => {
    const body = document.body;
    return {
      bodyScrollWidth: body.scrollWidth,
      bodyClientWidth: body.clientWidth,
      mainScrollWidth:
        document.querySelector("#main-content")?.scrollWidth ?? -1,
      mainClientWidth:
        document.querySelector("#main-content")?.clientWidth ?? -1,
      viewport: [window.innerWidth, window.innerHeight],
      theme: document.documentElement.dataset.theme,
    };
  });
  console.log("layout:", JSON.stringify(layout));

  await page.getByRole("button", { name: "停止", exact: true }).first().click();
  await waitForState(id, "stopped");
  console.log("stopped cleanly");
} catch (error) {
  console.error("WALKTHROUGH FAILED:", error);
  await page.screenshot({ path: path.join(shotDir, "failure.png") });
  console.error(
    "BODY:",
    (await page.locator("body").innerText()).slice(0, 4000),
  );
} finally {
  console.log("LOGS:\n" + logs.join("\n"));
  await app.close().catch(() => undefined);
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}
