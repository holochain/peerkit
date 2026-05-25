#!/usr/bin/env node
/**
 * Updates @peerkit/* dependency references across all workspace package.json files,
 * replacing ^<oldVersion> with ^<newVersion>. Only replaces exact matches on the old
 * version so unrelated version strings are never touched.
 *
 * Usage: node scripts/bump-internal-deps.mjs <old-version> <new-version>
 * Example: node scripts/bump-internal-deps.mjs 0.1.0-alpha.9 0.1.0-alpha.10
 *
 * Must be run from the repository root.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [, , oldVersion, newVersion] = process.argv;

if (!oldVersion || !newVersion) {
  console.error(
    "Usage: node scripts/bump-internal-deps.mjs <old-version> <new-version>",
  );
  process.exit(1);
}

const oldRange = `^${oldVersion}`;
const newRange = `^${newVersion}`;
const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const packageJsonFiles = readdirSync("packages", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("packages", entry.name, "package.json"));

for (const file of packageJsonFiles) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  const pkg = JSON.parse(raw);
  let changed = false;

  for (const field of DEP_FIELDS) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith("@peerkit/") && deps[name] === oldRange) {
        deps[name] = newRange;
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`Updated ${file}`);
  }
}
