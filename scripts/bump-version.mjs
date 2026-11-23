#!/usr/bin/env node
/**
 * Sets one version everywhere it is written, and opens it in the changelog.
 *
 *   pnpm version:bump 0.2.0
 *
 * Updates package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml and the
 * app's entry in src-tauri/Cargo.lock, then turns `## [Unreleased]` in
 * CHANGELOG.md into `## [0.2.0] - <today>`. Nothing is committed or tagged:
 * the commands for that are printed at the end.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_URL = "https://github.com/develoverli/assay-code";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** Replaces exactly one match, so a file whose shape changed fails loudly instead of silently. */
function replaceOnce(file, pattern, replacement) {
  const path = resolve(ROOT, file);
  const text = readFileSync(path, "utf8");
  const matches = text.match(new RegExp(pattern.source, pattern.flags.replace("g", "") + "g"));
  if (matches?.length !== 1) fail(`${file}: expected one version to replace, found ${matches?.length ?? 0}.`);
  writeFileSync(path, text.replace(pattern, replacement));
}

function currentVersion() {
  return JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).version;
}

function updateChangelog(previous, next) {
  const path = resolve(ROOT, "CHANGELOG.md");
  let text = readFileSync(path, "utf8");
  if (text.includes(`## [${next}]`)) fail(`CHANGELOG.md already has a section for ${next}.`);
  if (!text.includes("## [Unreleased]")) fail("CHANGELOG.md has no `## [Unreleased]` section.");

  // the release date where the maintainer is, not in UTC
  const now = new Date();
  const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((n) => String(n).padStart(2, "0"))
    .join("-");
  text = text.replace("## [Unreleased]", `## [Unreleased]\n\n## [${next}] - ${today}`);
  text = text.replace(
    /^\[Unreleased\]: .*$/m,
    `[Unreleased]: ${REPO_URL}/compare/v${next}...HEAD\n[${next}]: ${REPO_URL}/compare/v${previous}...v${next}`,
  );
  writeFileSync(path, text);
}

const next = process.argv[2]?.replace(/^v/, "");
if (!next || !SEMVER.test(next)) fail("Usage: pnpm version:bump <major.minor.patch[-pre]>");

const previous = currentVersion();
if (previous === next) fail(`The version is already ${next}.`);

replaceOnce("package.json", /"version": "[^"]+"/, `"version": "${next}"`);
replaceOnce("src-tauri/tauri.conf.json", /"version": "[^"]+"/, `"version": "${next}"`);
replaceOnce("src-tauri/Cargo.toml", /^version = "[^"]+"/m, `version = "${next}"`);
replaceOnce("src-tauri/Cargo.lock", /(name = "assay"\r?\nversion = )"[^"]+"/, `$1"${next}"`);
updateChangelog(previous, next);

console.log(`
${previous} -> ${next}

Next:
  1. Write the release notes under "## [${next}]" in CHANGELOG.md
  2. git add -A && git commit -m "🔖 chore(release): v${next}"
  3. git tag -a v${next} -m "v${next}"
  4. git push origin main --follow-tags
`);
