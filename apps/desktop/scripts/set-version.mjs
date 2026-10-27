import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Release tags are the source of the packaged version. Keep the validation in
// sync with the tag check in .github/workflows/release.yml.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const version = process.argv[2];

if (version === undefined || !VERSION.test(version)) {
  console.error("usage: node scripts/set-version.mjs <major.minor.patch>");
  process.exit(1);
}

const packageFile = path.resolve(import.meta.dirname, "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
packageJson.version = version;
writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);

console.log(`[set-version] @virealm/desktop is now ${version}`);
