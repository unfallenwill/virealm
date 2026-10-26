import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
const userData = await mkdtemp(path.join(tmpdir(), "virealm-errors-"));

const app = await electron.launch({
  executablePath: electronPath,
  args: [appRoot],
  cwd: appRoot,
  env: {
    ...process.env,
    VIREALM_USER_DATA_DIR: userData,
    VIREALM_RUNTIME_PATH: path.join(
      userData,
      process.platform === "win32" ? "missing-runtime.exe" : "missing-runtime",
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
await page.waitForTimeout(2500);

let index = 0;
async function shot(name) {
  index += 1;
  await page.screenshot({
    path: path.join(
      shotDir,
      `err-${String(index).padStart(2, "0")}-${name}.png`,
    ),
  });
  console.log(`shot: ${name}`);
}

try {
  await shot("list-runtime-unavailable");
  await page.getByTitle("设置 (Ctrl+,)").click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "运行时与诊断" }).click();
  await page.waitForTimeout(600);
  await shot("runtime-unavailable");

  await page
    .getByRole("navigation")
    .getByRole("button", { name: "环境" })
    .click();
  await page.getByRole("button", { name: "新建环境" }).click();
  await page.waitForTimeout(400);
  await shot("editor-runtime-unavailable");
  await page.keyboard.press("Escape");

  const launch = await page.evaluate(async () => {
    const result = await window.virealm.launchEnvironment("env-does-not-exist");
    return result;
  });
  console.log("invalid id result:", JSON.stringify(launch));
} catch (error) {
  console.error("ERROR WALKTHROUGH FAILED:", error);
  await page.screenshot({ path: path.join(shotDir, "err-failure.png") });
} finally {
  console.log("LOGS:\n" + logs.join("\n"));
  await app.close().catch(() => undefined);
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}
