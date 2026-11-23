import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readFile, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { arch, platform } from "@tauri-apps/plugin-os";
import { fetch } from "@tauri-apps/plugin-http";
import { probe, runOnce, runTokens } from "@/lib/exec";
import { tr } from "@/lib/i18n";

/**
 * Assay's own linter install in appdata, outside every scanned project. ESLint
 * resolves plugins next to its config, so it runs from here with
 * `--no-config-lookup` and nothing is written into the audited repo.
 *
 * Ruff, Gitleaks and OSV Scanner are not on npm: their official binaries are
 * cached here unless the user has one on PATH. Ruff is fetched on demand by a
 * lint run; the other two only by an explicit Install click.
 */

export type Log = (chunk: string) => void;

const RUFF_URL_BASE = "https://github.com/astral-sh/ruff/releases/latest/download";
const GITLEAKS_REPO = "gitleaks/gitleaks";
/** Used when GitHub can't be asked for the current tag. Gitleaks puts the
 *  version inside the asset name, so "latest/download" alone is not enough. */
const GITLEAKS_FALLBACK = "v8.30.1";
const OSV_URL_BASE = "https://github.com/google/osv-scanner/releases/latest/download";
/** Records the package set the node sandbox was last installed with. */
const INSTALL_STAMP = ".assay-install.json";
const RUFF_VERSION_CMD = "ruff --version";

let rootPromise: Promise<string> | null = null;

/** `<appdata>/linters` — created on first use. */
async function sandboxRoot(): Promise<string> {
  if (!rootPromise) {
    rootPromise = (async () => {
      const dir = await join(await appDataDir(), "linters");
      await mkdir(dir, { recursive: true });
      return dir;
    })();
  }
  return rootPromise;
}

async function nodeDir(): Promise<string> {
  return join(await sandboxRoot(), "node");
}

async function ruffDir(): Promise<string> {
  return join(await sandboxRoot(), "ruff");
}

async function binDir(): Promise<string> {
  return join(await sandboxRoot(), "bin");
}

async function isWindows(): Promise<boolean> {
  return (await platform()) === "windows";
}

/* ---------------------------------- node ------------------------------------ */
/** `eslint@^9` → `["eslint", "^9"]`, scope-safe. */
function splitSpec(spec: string): [string, string] {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return [spec, "latest"];
  return [spec.slice(0, at), spec.slice(at + 1)];
}

function manifest(packages: string[]): string {
  const byName = new Map<string, string>();
  for (const spec of packages) {
    const [name, range] = splitSpec(spec);
    byName.set(name, range);
  }
  const deps = Object.fromEntries(byName);
  return `${JSON.stringify(
    {
      name: "assay-linters",
      version: "1.0.0",
      private: true,
      type: "module",
      description: "Linters Assay installs for itself. Safe to delete: Assay rebuilds it.",
      dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
    },
    null,
    2,
  )}\n`;
}

/** pnpm when it's there (the project standard), npm as the fallback that always is. */
async function packageManager(): Promise<"pnpm" | "npm"> {
  return (await probe("pnpm --version")) ? "pnpm" : "npm";
}

async function alreadyInstalled(dir: string, wanted: string): Promise<boolean> {
  const stamp = await join(dir, INSTALL_STAMP);
  if (!(await exists(stamp))) return false;
  if (!(await exists(await join(dir, "node_modules", "eslint", "package.json")))) return false;
  try {
    return (await readTextFile(stamp)) === wanted;
  } catch {
    return false;
  }
}

/**
 * Make sure the sandbox holds exactly these packages, installing only when the
 * set actually changed. Returns the directory.
 */
export async function ensureNodeSandbox(packages: string[], log: Log): Promise<string> {
  const dir = await nodeDir();
  await mkdir(dir, { recursive: true });
  const pkgJson = manifest(packages);

  if (await alreadyInstalled(dir, pkgJson)) return dir;

  await writeTextFile(await join(dir, "package.json"), pkgJson);
  const pm = await packageManager();
  log(`[assay] installing the linter sandbox with ${pm} (first run only, this takes a minute)\n`);
  log(`[assay] ${packages.join(", ")}\n`);
  const args =
    pm === "pnpm"
      ? ["pnpm", "install", "--no-frozen-lockfile", "--config.node-linker=hoisted"]
      : ["npm", "install", "--no-audit", "--no-fund"];
  const { result } = runTokens(args, { cwd: dir, onData: (chunk) => log(chunk) });
  const res = await result;
  if (res.code !== 0) {
    throw new Error(
      `Installing the linter sandbox failed (${pm} exited ${res.code}). Is Node installed and reachable?`,
    );
  }
  await writeTextFile(await join(dir, INSTALL_STAMP), pkgJson);
  log("[assay] sandbox ready\n");
  return dir;
}

/** ESLint's own entry point — invoked through `node`, so no .cmd/.bin differences. */
export async function eslintEntry(): Promise<string> {
  return join(await nodeDir(), "node_modules", "eslint", "bin", "eslint.js");
}

/** Writes the gitleaks allowlist into the sandbox root, never the repo, and returns its path. */
export async function writeGitleaksConfig(source: string): Promise<string> {
  const path = await join(await sandboxRoot(), "gitleaks.toml");
  await writeTextFile(path, source);
  return path;
}

/** Writes the generated flat config next to the sandbox install and returns its path. */
export async function writeEslintConfig(source: string): Promise<string> {
  const path = await join(await nodeDir(), "eslint.config.mjs");
  await writeTextFile(path, source);
  return path;
}

/* ------------------------------- checksums ---------------------------------- */
const SHA256_LINE = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/;

/**
 * `sha256sum`-style text (`<hash>  <name>`, `<hash> *<name>`, or a bare hash) as
 * name → lowercase hash. Names are reduced to their last path segment; a bare hash
 * is stored under "".
 */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = SHA256_LINE.exec(raw.trim());
    if (!m) continue;
    const name = (m[2] ?? "").trim();
    out.set(name.slice(name.lastIndexOf("/") + 1), m[1].toLowerCase());
  }
  return out;
}

/** The hash published for `asset`; a file holding one bare hash answers for whatever it sits beside. */
export function expectedChecksum(text: string, asset: string): string | null {
  const sums = parseChecksums(text);
  const named = sums.get(asset);
  if (named) return named;
  return sums.size === 1 ? (sums.get("") ?? null) : null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Check a download against the checksum file of the same release before anything
 * unpacks or runs it. A mismatch or a missing checksum deletes the file and throws.
 */
async function verifyDownload(file: string, asset: string, checksumUrl: string, log: Log): Promise<void> {
  log(`[assay] verifying against ${checksumUrl}\n`);
  const sums = await runTokens(["curl", "-fsSL", checksumUrl]).result;
  const expected = sums.code === 0 ? expectedChecksum(sums.stdout, asset) : null;
  if (!expected) {
    await remove(file).catch(() => {});
    throw new Error(
      tr("No SHA-256 checksum for {asset} could be read from its release, so the download was deleted unverified.", { asset }),
    );
  }
  const actual = await sha256Hex(await readFile(file));
  if (actual !== expected) {
    await remove(file).catch(() => {});
    log(`[assay] sha256 expected ${expected}\n[assay] sha256 actual   ${actual}\n`);
    throw new Error(
      tr("The download of {asset} does not match the SHA-256 its release publishes, so it was deleted. Try again later.", { asset }),
    );
  }
  log(`[assay] sha256 ok ${actual}\n`);
}

/* ---------------------------------- ruff ------------------------------------ */
async function ruffAsset(): Promise<{ asset: string; zip: boolean }> {
  const p = await platform();
  // the typed union doesn't spell aarch64, but that is what an arm64 host reports
  const a = String(await arch());
  const cpu = a === "aarch64" || a === "arm64" || a === "arm" ? "aarch64" : "x86_64";
  if (p === "windows") return { asset: `ruff-${cpu}-pc-windows-msvc.zip`, zip: true };
  if (p === "macos") return { asset: `ruff-${cpu}-apple-darwin.tar.gz`, zip: false };
  return { asset: `ruff-${cpu}-unknown-linux-gnu.tar.gz`, zip: false };
}

async function cachedRuff(): Promise<string | null> {
  const dir = await ruffDir();
  const bin = await join(dir, (await isWindows()) ? "ruff.exe" : "ruff");
  return (await exists(bin)) ? bin : null;
}

/**
 * Resolve a usable ruff: the user's own install, then the cached one, then the
 * official release (via curl + tar, present on every supported platform).
 */
export async function ensureRuff(log: Log): Promise<string> {
  if (await probe(RUFF_VERSION_CMD)) {
    log("[assay] using the ruff already on your PATH\n");
    return "ruff";
  }
  const cached = await cachedRuff();
  if (cached) return cached;

  const dir = await ruffDir();
  await mkdir(dir, { recursive: true });
  const { asset, zip } = await ruffAsset();
  const url = `${RUFF_URL_BASE}/${asset}`;
  const archive = await join(dir, asset);
  log(`[assay] downloading ruff — ${url}\n`);

  const dl = runTokens(["curl", "-fsSL", "-o", archive, url], { cwd: dir, onData: log });
  const dlRes = await dl.result;
  if (dlRes.code !== 0) throw new Error(`Downloading ruff failed (curl exited ${dlRes.code}).`);
  // cargo-dist publishes `<asset>.sha256` beside every archive
  await verifyDownload(archive, asset, `${url}.sha256`, log);

  log("[assay] extracting\n");
  const extract = zip
    ? runTokens(["tar", "-xf", archive, "-C", dir], { cwd: dir, onData: log })
    : runTokens(["tar", "-xzf", archive, "-C", dir, "--strip-components=1"], { cwd: dir, onData: log });
  const exRes = await extract.result;
  if (exRes.code !== 0) throw new Error(`Extracting ruff failed (tar exited ${exRes.code}).`);
  await remove(archive).catch(() => {});

  const bin = await cachedRuff();
  if (!bin) throw new Error("Ruff downloaded but no binary was found in the archive.");
  if (!(await isWindows())) await runOnce(`chmod +x "${bin}"`);
  log("[assay] ruff ready\n");
  return bin;
}

/* --------------------------------- status ----------------------------------- */
export interface SandboxStatus {
  /** Directory holding both sandboxes. */
  root: string;
  eslintInstalled: boolean;
  eslintVersion: string | null;
  /** "PATH" when the user's own ruff is used, "sandbox" when Assay fetched it. */
  ruffSource: "PATH" | "sandbox" | null;
  ruffVersion: string | null;
  packageManager: "pnpm" | "npm";
}

async function versionOf(cmd: string): Promise<string | null> {
  try {
    const res = await runOnce(cmd);
    if (res.code !== 0) return null;
    const line = res.combined.trim().split("\n")[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}

export async function sandboxStatus(): Promise<SandboxStatus> {
  const [root, entry] = await Promise.all([sandboxRoot(), eslintEntry()]);
  const [eslintInstalled, onPath] = await Promise.all([exists(entry), probe(RUFF_VERSION_CMD)]);
  const cached = onPath ? null : await cachedRuff();
  let ruffSource: SandboxStatus["ruffSource"] = null;
  let ruffVersion: string | null = null;
  if (onPath) {
    ruffSource = "PATH";
    ruffVersion = await versionOf(RUFF_VERSION_CMD);
  } else if (cached) {
    ruffSource = "sandbox";
    ruffVersion = await versionOf(`"${cached}" --version`);
  }
  return {
    root,
    eslintInstalled,
    eslintVersion: eslintInstalled ? await versionOf(`node "${entry}" --version`) : null,
    ruffSource,
    ruffVersion,
    packageManager: await packageManager(),
  };
}

/** Delete everything Assay installed for linting. The next run rebuilds it. */
export async function removeSandbox(): Promise<void> {
  const root = await sandboxRoot();
  await remove(root, { recursive: true }).catch(() => {});
  rootPromise = null;
}

/** Force the next run to reinstall, without deleting the download cache. */
export async function invalidateNodeSandbox(): Promise<void> {
  const stamp = await join(await nodeDir(), INSTALL_STAMP);
  await remove(stamp).catch(() => {});
}

/* ------------------------ standalone binaries (on demand) ------------------- */
/**
 * Scanners Assay can fetch from their own GitHub release. Never downloaded by a
 * scan, only by Install in Tools.
 */
export type FetchableId = "gitleaks" | "osv-scanner";

/** amd64/arm64 as the release assets spell it. */
async function cpuArch(): Promise<"arm64" | "amd64"> {
  const a = String(await arch());
  return a === "aarch64" || a === "arm64" || a === "arm" ? "arm64" : "amd64";
}

function exeName(id: FetchableId, windows: boolean): string {
  return windows ? `${id}.exe` : id;
}

async function fetchableBin(id: FetchableId): Promise<string> {
  return join(await binDir(), exeName(id, await isWindows()));
}

/** The cached copy, if this machine already downloaded it. */
async function cachedBinary(id: FetchableId): Promise<string | null> {
  const bin = await fetchableBin(id);
  return (await exists(bin)) ? bin : null;
}

/** What to run: the user's own copy first (the one they update), then Assay's. Null = not installed. */
export async function resolveBinary(id: FetchableId): Promise<string | null> {
  if (await probe(`${id} --version`)) return id;
  return cachedBinary(id);
}

/** Gitleaks names its assets after the version, so the version has to be known. */
async function latestTag(repo: string, fallback: string): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return fallback;
    const tag = (await res.json())?.tag_name;
    return typeof tag === "string" && /^v?\d/.test(tag) ? tag : fallback;
  } catch {
    // no network, a rate limit, a proxy: the pinned version still works
    return fallback;
  }
}

interface Download {
  url: string;
  /** The asset's file name, as its release's checksum file lists it. */
  asset: string;
  /** The checksum file published in the same release. */
  checksumUrl: string;
  /** Set when the download is an archive that has to be unpacked. */
  archive: "zip" | "tar.gz" | null;
}

/** The name each release uses for the platform Assay is running on. */
function osSlug(windows: boolean, macos: boolean): string {
  if (windows) return "windows";
  if (macos) return "darwin";
  return "linux";
}

async function downloadFor(id: FetchableId): Promise<Download> {
  const windows = await isWindows();
  const macos = (await platform()) === "macos";
  const cpu = await cpuArch();

  if (id === "osv-scanner") {
    // one bare executable per platform, no version in the name
    const os = osSlug(windows, macos);
    const suffix = windows ? ".exe" : "";
    const asset = `osv-scanner_${os}_${cpu}${suffix}`;
    return { url: `${OSV_URL_BASE}/${asset}`, asset, checksumUrl: `${OSV_URL_BASE}/osv-scanner_SHA256SUMS`, archive: null };
  }

  const tag = await latestTag(GITLEAKS_REPO, GITLEAKS_FALLBACK);
  const version = tag.replace(/^v/, "");
  // gitleaks writes x64, not amd64
  const slice = cpu === "arm64" ? "arm64" : "x64";
  const os = osSlug(windows, macos);
  const ext = windows ? "zip" : "tar.gz";
  const base = `https://github.com/${GITLEAKS_REPO}/releases/download/${tag}`;
  const asset = `gitleaks_${version}_${os}_${slice}.${ext}`;
  return { url: `${base}/${asset}`, asset, checksumUrl: `${base}/gitleaks_${version}_checksums.txt`, archive: ext };
}

/** Fetch one of them into the sandbox with curl + tar. */
export async function installBinary(id: FetchableId, log: Log): Promise<string> {
  const dir = await binDir();
  await mkdir(dir, { recursive: true });
  const [{ url, asset, checksumUrl, archive }, target] = await Promise.all([downloadFor(id), fetchableBin(id)]);
  const tmp = archive ? await join(dir, `${id}-download.${archive}`) : target;

  log(`[assay] downloading ${id} — ${url}\n`);
  const dl = await runTokens(["curl", "-fsSL", "-o", tmp, url], { cwd: dir, onData: log }).result;
  if (dl.code !== 0) throw new Error(`Downloading ${id} failed (curl exited ${dl.code}).`);
  await verifyDownload(tmp, asset, checksumUrl, log);

  if (archive) {
    log("[assay] extracting\n");
    const args = archive === "zip" ? ["tar", "-xf", tmp, "-C", dir] : ["tar", "-xzf", tmp, "-C", dir];
    const ex = await runTokens(args, { cwd: dir, onData: log }).result;
    if (ex.code !== 0) throw new Error(`Extracting ${id} failed (tar exited ${ex.code}).`);
    await remove(tmp).catch(() => {});
  }

  if (!(await exists(target))) throw new Error(`${id} downloaded but no binary was found.`);
  if (!(await isWindows())) await runOnce(`chmod +x "${target}"`);
  log(`[assay] ${id} ready\n`);
  return target;
}
