import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { SCOPE_NAME, SCOPE_VERSION } from "../src/metrics.js";

interface PackageJson {
  readonly name: string;
  readonly version: string;
}

const packageJsonPath = fileURLToPath(
  new URL("../package.json", import.meta.url),
);
const packageJson = JSON.parse(
  readFileSync(packageJsonPath, "utf8"),
) as PackageJson;

describe("metrics scope", () => {
  test("SCOPE_NAME matches package.json name", () => {
    expect(SCOPE_NAME).toBe(packageJson.name);
  });

  test("SCOPE_VERSION matches package.json version", () => {
    expect(SCOPE_VERSION).toBe(packageJson.version);
  });
});
