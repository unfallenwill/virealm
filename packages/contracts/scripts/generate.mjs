import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { OUTPUT_FILES, renderGeneratedFiles } from "./generate-lib.mjs";

const files = await renderGeneratedFiles();
for (const file of Object.values(OUTPUT_FILES)) {
  await mkdir(dirname(file), { recursive: true });
}
for (const [file, contents] of files) {
  await writeFile(file, contents, "utf8");
  console.log(`generated ${file}`);
}
