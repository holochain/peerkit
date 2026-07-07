import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.env.npm_new_version;
if (!version) throw new Error("npm_new_version is not set");

const packagesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
);

const files = readdirSync(packagesDir, { recursive: true }).filter(
  (f) =>
    !f.includes("node_modules") &&
    (f.endsWith("metrics.ts") || f.endsWith("package.json")),
);

for (const file of files) {
  const fullPath = join(packagesDir, file);
  const original = readFileSync(fullPath, "utf8");
  let updated = original;

  if (file.endsWith("metrics.ts")) {
    updated = updated.replace(
      /SCOPE_VERSION = "[^"]*"/g,
      `SCOPE_VERSION = "${version}"`,
    );
  } else {
    updated = updated.replace(
      /"@peerkit\/([^"]*)": "[^"]*"/g,
      `"@peerkit/$1": "^${version}"`,
    );
  }

  if (updated !== original) writeFileSync(fullPath, updated);
}
