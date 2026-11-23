import type { Tool, ToolPlugin } from "@/types";
import { SKIP_DIRS } from "@/lib/detect";

/**
 * What a tool can be configured with, declared in code and rendered generically
 * by the Tools view. Options are global to the tool, not per project.
 */

export interface ToolOption {
  id: string;
  label: string;
  hint?: string;
  /** On for a fresh install. */
  default: boolean;
  /** npm packages this option pulls into the sandbox (ESLint side). */
  packages?: string[];
  /** Ruff rule-set prefixes this option selects (`--select`). */
  select?: string[];
}

export interface ToolOptionSchema {
  /** Sentence shown above the checkboxes. */
  intro: string;
  options: ToolOption[];
  /** Whether the user can add extra npm plugins on top. */
  allowPlugins: boolean;
}

/* --------------------------------- eslint ----------------------------------- */
/** Pinned to a major so two machines produce the same findings. */
const ESLINT_CORE_PACKAGES = [
  "eslint@^9",
  "@eslint/js@^9",
  "globals@^15",
];

const ESLINT_OPTIONS: ToolOption[] = [
  {
    id: "js",
    label: "JavaScript recommended",
    hint: "@eslint/js — the rules ESLint itself ships",
    default: true,
    packages: [],
  },
  {
    id: "ts",
    label: "TypeScript",
    hint: "typescript-eslint, syntax only (fast)",
    default: true,
    packages: ["typescript-eslint@^8", "typescript@^5"],
  },
  {
    id: "ts-type-aware",
    label: "TypeScript type-aware",
    hint: "needs a tsconfig.json; much slower, finds real type bugs",
    default: false,
    packages: ["typescript-eslint@^8", "typescript@^5"],
  },
  {
    id: "react",
    label: "React + Hooks",
    hint: "eslint-plugin-react, eslint-plugin-react-hooks",
    default: true,
    packages: ["eslint-plugin-react@^7", "eslint-plugin-react-hooks@^5"],
  },
  {
    id: "a11y",
    label: "Accessibility",
    hint: "eslint-plugin-jsx-a11y",
    default: false,
    packages: ["eslint-plugin-jsx-a11y@^6"],
  },
  {
    id: "security",
    label: "Security",
    hint: "eslint-plugin-security — injection, unsafe regex, child_process",
    default: true,
    packages: ["eslint-plugin-security@^3"],
  },
  {
    id: "imports",
    label: "Imports",
    hint: "eslint-plugin-import-x — unresolved, cycles, duplicates",
    default: false,
    packages: ["eslint-plugin-import-x@^4"],
  },
  {
    id: "node",
    label: "Node",
    hint: "eslint-plugin-n — Node APIs and package.json coherence",
    default: false,
    packages: ["eslint-plugin-n@^17"],
  },
  {
    id: "unicorn",
    label: "Unicorn",
    hint: "eslint-plugin-unicorn — opinionated; expect volume",
    default: false,
    packages: ["eslint-plugin-unicorn@^56"],
  },
];

/* ---------------------------------- ruff ------------------------------------ */
const RUFF_OPTIONS: ToolOption[] = [
  { id: "F", label: "Pyflakes", hint: "undefined names, unused imports (F)", default: true, select: ["F"] },
  { id: "E", label: "pycodestyle", hint: "style and syntax errors (E, W)", default: true, select: ["E", "W"] },
  { id: "S", label: "Security", hint: "bandit rules: subprocess, eval, hardcoded secrets (S)", default: true, select: ["S"] },
  { id: "B", label: "Bugbear", hint: "likely bugs and footguns (B)", default: true, select: ["B"] },
  { id: "PL", label: "Pylint rules", hint: "the Pylint checks Ruff reimplements (PL)", default: false, select: ["PL"] },
  { id: "I", label: "Import order", hint: "isort (I)", default: false, select: ["I"] },
  { id: "N", label: "Naming", hint: "pep8-naming (N)", default: false, select: ["N"] },
  { id: "UP", label: "Modernize", hint: "pyupgrade (UP)", default: false, select: ["UP"] },
  { id: "SIM", label: "Simplify", hint: "flake8-simplify (SIM)", default: false, select: ["SIM"] },
  { id: "ASYNC", label: "Async", hint: "blocking calls inside async (ASYNC)", default: false, select: ["ASYNC"] },
];

/* -------------------------------- semgrep ----------------------------------- */
/** Each pack is a `--config` semgrep resolves itself; nothing is vendored here. */
const SEMGREP_OPTIONS: ToolOption[] = [
  { id: "p/default", label: "Default rules", hint: "semgrep's own curated set", default: true },
  { id: "p/security-audit", label: "Security audit", hint: "injection, deserialization, crypto", default: true },
  { id: "p/secrets", label: "Secrets", hint: "credentials in code", default: false },
  { id: "p/owasp-top-ten", label: "OWASP Top 10", hint: "the classic ten categories", default: false },
  { id: "p/ci", label: "CI pack", hint: "high-confidence rules only, low noise", default: false },
  { id: "p/react", label: "React", hint: "React-specific rules", default: false },
  { id: "p/python", label: "Python", hint: "Python-specific rules", default: false },
];

/* -------------------------------- gitleaks ---------------------------------- */
/** Gitleaks reads either the files on disk or the commits, never both in one pass: this is a mode. */
const GITLEAKS_OPTIONS: ToolOption[] = [
  {
    id: "history",
    label: "Scan git history instead",
    hint: "every commit, so a secret that was committed and later deleted still shows up. Slower, and uncommitted files are not read in this mode.",
    default: false,
  },
];

/* -------------------------------- graphify ---------------------------------- */
/** All off by default: the default run needs no key, no network and no prompt. */
const GRAPHIFY_OPTIONS: ToolOption[] = [
  {
    id: "docs",
    label: "Include docs, papers and images",
    hint: "sends them to an LLM backend (GEMINI_API_KEY / GOOGLE_API_KEY…). Off, graphify reads code only — local AST, no key, no network.",
    default: false,
  },
  {
    id: "deep",
    label: "Deep mode",
    hint: "--mode deep: more inferred edges, a slower run",
    default: false,
  },
  {
    id: "directed",
    label: "Directed graph",
    hint: "keeps edge direction (calls, imports) instead of collapsing A↔B",
    default: false,
  },
  {
    id: "no-cluster",
    label: "Skip clustering",
    hint: "--no-cluster: raw extraction only. Much faster on a huge repo; no communities in the report.",
    default: false,
  },
  {
    id: "report",
    label: "Report (GRAPH_REPORT.md)",
    hint: "graphify cluster-only: communities, hubs and freshness in markdown, and graph.html along with it. Names the communities only when an LLM backend is configured; otherwise they stay Community N.",
    default: false,
  },
  {
    id: "html",
    label: "Interactive graph (graph.html)",
    hint: "graphify export html: one self-contained page, no server and no key. Included already when the report is on.",
    default: false,
  },
  {
    id: "tree",
    label: "File tree (GRAPH_TREE.html)",
    hint: "graphify tree: the same graph as a collapsible tree of the folders it came from.",
    default: false,
  },
  {
    id: "callflow",
    label: "Call flow (<project>-callflow.html)",
    hint: "graphify export callflow-html: architecture and call paths as Mermaid diagrams.",
    default: false,
  },
];

const TOOL_OPTIONS: Record<string, ToolOptionSchema> = {
  semgrep: {
    intro: "Rule packs semgrep downloads and runs. More packs means more findings and a slower scan.",
    options: SEMGREP_OPTIONS,
    allowPlugins: false,
  },
  eslint: {
    intro:
      "Assay lints with its own ESLint install, so the project's own config is never read or written. Pick what runs.",
    options: ESLINT_OPTIONS,
    allowPlugins: true,
  },
  ruff: {
    intro: "Ruff rule sets. Each one maps to a --select prefix; nothing is written into the project.",
    options: RUFF_OPTIONS,
    allowPlugins: false,
  },
  gitleaks: {
    intro:
      "Gitleaks runs redacted either way: Assay records the rule and the location, never the secret itself.",
    options: GITLEAKS_OPTIONS,
    allowPlugins: false,
  },
  graphify: {
    intro:
      "Graphify builds the graph from the code with a local parser — nothing leaves the machine and nothing is asked of you mid-run. The first options trade that away for something; the last four write the pages and the report the extraction alone does not.",
    options: GRAPHIFY_OPTIONS,
    allowPlugins: false,
  },
};

export function schemaFor(tool: Tool): ToolOptionSchema | null {
  return TOOL_OPTIONS[tool.id] ?? null;
}

/** The option ids a tool runs with: what the user stored, or the defaults. */
export function enabledGroups(tool: Tool): string[] {
  const schema = schemaFor(tool);
  if (!schema) return [];
  const stored = tool.config?.groups;
  if (!stored) {
    return schema.options.reduce<string[]>((ids, o) => {
      if (o.default) ids.push(o.id);
      return ids;
    }, []);
  }
  return stored.filter((id) => schema.options.some((o) => o.id === id));
}

export function pluginsOf(tool: Tool): ToolPlugin[] {
  return tool.config?.plugins ?? [];
}

/* ------------------------------ eslint sandbox ------------------------------ */
/** Every npm package the enabled options (plus user plugins) need. */
export function eslintPackages(tool: Tool): string[] {
  const on = new Set(enabledGroups(tool));
  const pkgs = new Set(ESLINT_CORE_PACKAGES);
  for (const o of ESLINT_OPTIONS) {
    if (!on.has(o.id)) continue;
    for (const p of o.packages ?? []) pkgs.add(p);
  }
  for (const p of pluginsOf(tool)) if (p.pkg.trim()) pkgs.add(p.pkg.trim());
  return [...pkgs].sort((a, b) => a.localeCompare(b));
}

/** `eslint-plugin-sonarjs` → `sonarjs`; a scoped package keeps its scope. */
function pluginNamespace(pkg: string): string {
  const bare = pkg.replace(/@[^@/]+$/, "");
  if (bare.startsWith("@")) return bare.replace("/eslint-plugin", "").replace(/^@/, "").split("/")[0];
  return bare.replace(/^eslint-plugin-/, "");
}

/** A JS identifier safe to bind an import to. */
function importIdent(pkg: string, i: number): string {
  const base = pluginNamespace(pkg).replace(/[^A-Za-z0-9]/g, "");
  return `p${i}${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}

const IGNORED_DIRS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/target/**",
  "**/.venv/**",
  "**/*.min.js",
];

/** The `import` header the generated flat config needs for the enabled groups. */
function eslintImports(on: Set<string>, plugins: ToolPlugin[]): string[] {
  const lines: string[] = [];
  lines.push('import js from "@eslint/js";');
  lines.push('import globals from "globals";');
  if (on.has("ts") || on.has("ts-type-aware")) lines.push('import tseslint from "typescript-eslint";');
  if (on.has("react")) {
    lines.push('import react from "eslint-plugin-react";');
    lines.push('import reactHooks from "eslint-plugin-react-hooks";');
  }
  if (on.has("a11y")) lines.push('import jsxA11y from "eslint-plugin-jsx-a11y";');
  if (on.has("security")) lines.push('import security from "eslint-plugin-security";');
  if (on.has("imports")) lines.push('import importX from "eslint-plugin-import-x";');
  if (on.has("node")) lines.push('import n from "eslint-plugin-n";');
  if (on.has("unicorn")) lines.push('import unicorn from "eslint-plugin-unicorn";');
  plugins.forEach((p, i) => lines.push(`import ${importIdent(p.pkg, i)} from ${JSON.stringify(p.pkg.replace(/@[^@/]+$/, ""))};`));
  return lines;
}

/** The flat-config block for one user-added npm plugin. */
function eslintPluginBlock(p: ToolPlugin, i: number): string {
  const ident = importIdent(p.pkg, i);
  const ns = p.preset.includes("/") ? p.preset.split("/")[0] : pluginNamespace(p.pkg);
  const preset = p.preset.includes("/") ? p.preset.split("/").slice(1).join("/") : p.preset || "recommended";
  const flatPreset = `flat/${preset}`;
  return `{ plugins: { ${JSON.stringify(ns)}: ${ident} }, rules: rulesOf(${ident}, ${JSON.stringify(preset)}, ${JSON.stringify(flatPreset)}) }`;
}

/**
 * The flat config Assay writes into its own sandbox before every run. Presets are
 * pulled as `configs.X.rules`, not spread: plugins ship flat or eslintrc shapes,
 * and only the rules are portable between the two.
 */
export function buildEslintConfig(tool: Tool, projectPath: string): string {
  const on = new Set(enabledGroups(tool));
  const plugins = pluginsOf(tool).filter((p) => p.pkg.trim());
  const lines: string[] = [];
  const blocks: string[] = [];

  lines.push(...eslintImports(on, plugins));

  // rules of a preset, whichever shape the plugin ships
  lines.push("");
  lines.push("const rulesOf = (plugin, ...names) => {");
  lines.push("  for (const name of names) {");
  lines.push("    const cfg = plugin?.configs?.[name] ?? plugin?.flatConfigs?.[name];");
  lines.push("    const found = Array.isArray(cfg) ? Object.assign({}, ...cfg.map((c) => c.rules ?? {})) : cfg?.rules;");
  lines.push("    if (found) return found;");
  lines.push("  }");
  lines.push("  return {};");
  lines.push("};");

  blocks.push(`{ ignores: ${JSON.stringify(IGNORED_DIRS)} }`);
  blocks.push(
    `{ files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"], languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { ...globals.browser, ...globals.node }, parserOptions: { ecmaFeatures: { jsx: true } } } }`,
  );
  if (on.has("js")) blocks.push("js.configs.recommended");
  if (on.has("ts-type-aware")) {
    blocks.push("...tseslint.configs.recommendedTypeChecked");
    blocks.push(
      `{ files: ["**/*.{ts,mts,cts,tsx}"], languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: ${JSON.stringify(projectPath)} } } }`,
    );
  } else if (on.has("ts")) {
    blocks.push("...tseslint.configs.recommended");
  }
  if (on.has("react")) {
    // the recommended set assumes the pre-17 JSX transform and PropTypes, which
    // flags every element of a modern codebase
    blocks.push(
      '{ files: ["**/*.{jsx,tsx}"], plugins: { react, "react-hooks": reactHooks }, settings: { react: { version: "detect" } }, rules: { ...rulesOf(react, "recommended", "flat/recommended"), ...rulesOf(reactHooks, "recommended", "recommended-latest", "flat/recommended"), "react/react-in-jsx-scope": "off", "react/jsx-uses-react": "off", "react/prop-types": "off" } }',
    );
  }
  if (on.has("a11y")) {
    blocks.push('{ files: ["**/*.{jsx,tsx}"], plugins: { "jsx-a11y": jsxA11y }, rules: rulesOf(jsxA11y, "recommended", "flat/recommended") }');
  }
  if (on.has("security")) {
    blocks.push('{ plugins: { security }, rules: rulesOf(security, "recommended", "flat/recommended") }');
  }
  if (on.has("imports")) {
    blocks.push('{ plugins: { "import-x": importX }, rules: rulesOf(importX, "recommended", "flat/recommended") }');
  }
  if (on.has("node")) {
    blocks.push('{ plugins: { n }, rules: rulesOf(n, "flat/recommended", "recommended") }');
  }
  if (on.has("unicorn")) {
    blocks.push('{ plugins: { unicorn }, rules: rulesOf(unicorn, "flat/recommended", "recommended") }');
  }
  plugins.forEach((p, i) => blocks.push(eslintPluginBlock(p, i)));

  return `${lines.join("\n")}\n\nexport default [\n  ${blocks.join(",\n  ")},\n];\n`;
}

/* ------------------------------- semgrep args ------------------------------- */
/** `--config` for every enabled pack, with a floor of the default set. */
export function semgrepConfigs(tool: Tool): string[] {
  const on = enabledGroups(tool);
  return on.length ? on : ["p/default"];
}

/* -------------------------------- ruff args --------------------------------- */
/** `--select` codes for the enabled rule sets, always with a floor of Pyflakes. */
export function ruffSelect(tool: Tool): string[] {
  const on = new Set(enabledGroups(tool));
  const codes = new Set<string>();
  for (const o of RUFF_OPTIONS) {
    if (!on.has(o.id)) continue;
    for (const c of o.select ?? []) codes.add(c);
  }
  if (!codes.size) codes.add("F");
  return [...codes].sort((a, b) => a.localeCompare(b));
}

/**
 * A gitleaks config that keeps every built-in rule and skips `SKIP_DIRS`: build
 * output is full of high-entropy bytes gitleaks reports as "Generic API Key".
 */
export function buildGitleaksConfig(): string {
  const escaped = (d: string) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // TOML literal strings: nothing inside them is escaped, and no directory
  // name contains a single quote
  const paths = [...SKIP_DIRS]
    .sort((a, b) => a.localeCompare(b))
    .map((d) => `  '(^|/)${escaped(d)}/',`)
    .join("\n");
  return [
    "# Generated by Assay before every run. Edits here are overwritten.",
    'title = "Assay"',
    "",
    "[extend]",
    "useDefault = true",
    "",
    "[allowlist]",
    'description = "Build output, vendored code and VCS metadata."',
    "paths = [",
    paths,
    "]",
    "",
  ].join("\n");
}

/** Whether Gitleaks reads the commits rather than the working tree. */
export function gitleaksHistory(tool: Tool): boolean {
  return enabledGroups(tool).includes("history");
}
