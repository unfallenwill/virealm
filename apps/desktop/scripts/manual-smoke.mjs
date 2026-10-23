import { mkdir } from "node:fs/promises";
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

const app = await electron.launch({
  executablePath: electronPath,
  args: [appRoot],
  cwd: appRoot,
  env: {
    ...process.env,
    NODE_ENV: "production",
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
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(shotDir, "01-empty-dark.png") });
const text = await page.locator("body").innerText();
console.log("TITLE:", await page.title());
console.log("URL:", page.url());
console.log("BODY:\n" + text.slice(0, 3000));
console.log("LOGS:\n" + logs.join("\n"));

await app.close();
