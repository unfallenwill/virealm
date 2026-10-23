import { readFile } from "node:fs/promises";

import { renderGeneratedFiles } from "./generate-lib.mjs";

const expected = await renderGeneratedFiles();
const problems = [];

for (const [file, contents] of expected) {
  let actual;
  try {
    actual = await readFile(file, "utf8");
  } catch {
    problems.push(`${file}: missing`);
    continue;
  }
  if (actual !== contents) {
    const actualLines = actual.split("\n");
    const expectedLines = contents.split("\n");
    const index = expectedLines.findIndex((line, i) => line !== actualLines[i]);
    problems.push(
      `${file}: differs at line ${index + 1}\n  expected: ${expectedLines[index] ?? "<eof>"}\n  actual:   ${actualLines[index] ?? "<eof>"}`,
    );
  }
}

if (problems.length > 0) {
  console.error("Generated contract files are out of date:");
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  console.error("\nRun `pnpm generate` and commit the result.");
  process.exitCode = 1;
} else {
  console.log("Generated contract files are up to date.");
}
