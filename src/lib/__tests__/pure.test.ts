import { describe, expect, it } from "vitest";
import { tokenize } from "@/lib/runner";
import {
  agentCommand,
  binForShell,
  droppedPathText,
  promptEnv,
  scriptShellCommand,
  terminalPath,
  type ShellSpec,
} from "@/lib/bench-term";
import { knownBinPaths } from "@/lib/agent-bins";
import { installRecipe, type Managers } from "@/lib/toolchain";
import { clipboardPathText } from "@/lib/clipboard";
import { buildEslintConfig, buildGitleaksConfig, ruffSelect } from "@/lib/tool-options";
import { translate } from "@/lib/i18n";
import { canonicalTag, stackApplies } from "@/lib/detect";
import { applyFixLimit } from "@/lib/fix-limit";
import { moveTab, nudgeTab, orderTabs, storeOrder, type TabKey } from "@/lib/tab-order";
import { makeTargets, managerFrom, runScript, scriptNames } from "@/lib/scripts";
import { shortUntil, usageTone, windowElapsed } from "@/lib/claude-limits";
import {
  agentInstallTokens,
  artifactCommands,
  artifactOf,
  graphifyCommandLines,
  graphifyTokens,
  installCommandFor,
  parseGraphSummary,
  parseGraphifyVersion,
  skillStanding,
  staleSkillCount,
  type AgentSkill,
} from "@/lib/graphify";
import {
  aiChoiceLabel,
  aiChoiceValue,
  aiOptions,
  isLocalEndpoint,
  parseAIChoice,
  parseHermesStatus,
  parseTextEngine,
  textEngineLabel,
  textEngineValue,
  type AIInventory,
} from "@/lib/ai";
import {
  filterByTags,
  groupByTag,
  normalizeTagName,
  tagColorVar,
  tagNameError,
  tagUsage,
} from "@/lib/tags";
import { activeFirst, activeProjectKey, activityLabel, activityOf, sortByLastUse } from "@/lib/project-activity";
import { explainGitError, hasConflictMarkers, parseConflicts, parseStatusZ, resolveConflicts, webUrlFromRemote } from "@/lib/git";
import {
  cloneDestination,
  samePath,
  cloneEnv,
  filterByGithubOwner,
  filterRepos,
  githubOwnerOf,
  githubOwners,
  nextPageOf,
  readPollAnswer,
  grantFrom,
  needsRenewal,
  isGitHubHttpsRemote,
  remoteAuthEnv,
  type Repo,
} from "@/lib/github";
import {
  changesOf,
  DEFAULT_EXCLUDES,
  parseExcludes,
  parseSftpJson,
  serverAddress,
  stripJsonComments,
  toSftpJson,
} from "@/lib/deploy";
import type { DeployServer, Project, Tag, Tool } from "@/types";

/** The pure decisions the app leans on, tested without a browser or Tauri. */

const tool = (over: Partial<Tool> = {}): Tool => ({
  id: "eslint",
  name: "ESLint",
  source: "tool",
  kind: "cli",
  scope: "local",
  stack: [],
  cmd: "",
  adapter: "eslint",
  builtin: true,
  enabled: true,
  created_at: 0,
  updated_at: 0,
  ...over,
});

describe("tokenize", () => {
  it("keeps a quoted path with spaces in one piece", () => {
    expect(tokenize('npx tool "C:/my projects/app" --json')).toEqual([
      "npx",
      "tool",
      "C:/my projects/app",
      "--json",
    ]);
  });

  it("keeps an empty quoted argument", () => {
    expect(tokenize('cmd --flag ""')).toEqual(["cmd", "--flag", ""]);
  });

  it("refuses unbalanced quotes instead of guessing", () => {
    expect(tokenize('cmd "unterminated')).toBeNull();
  });
});

describe("ruffSelect", () => {
  it("uses the defaults when nothing was configured", () => {
    expect(ruffSelect(tool({ id: "ruff" }))).toEqual(["B", "E", "F", "S", "W"]);
  });

  it("never ends up selecting nothing", () => {
    expect(ruffSelect(tool({ id: "ruff", config: { groups: [] } }))).toEqual(["F"]);
  });
});

describe("buildEslintConfig", () => {
  it("only imports what the enabled options need", () => {
    const source = buildEslintConfig(tool({ config: { groups: ["js", "security"] } }), "D:/work/demo");
    expect(source).toContain('import security from "eslint-plugin-security"');
    expect(source).not.toContain("eslint-plugin-react");
    expect(source).toContain("js.configs.recommended");
  });

  it("silences the React rules that assume the pre-17 JSX transform", () => {
    const source = buildEslintConfig(tool({ config: { groups: ["react"] } }), "D:/work/demo");
    expect(source).toContain('"react/react-in-jsx-scope": "off"');
    expect(source).toContain('"react/prop-types": "off"');
  });

  it("points the type-aware parser at the project being scanned", () => {
    const source = buildEslintConfig(tool({ config: { groups: ["ts-type-aware"] } }), "D:/work/demo");
    expect(source).toContain("projectService: true");
    expect(source).toContain('tsconfigRootDir: "D:/work/demo"');
  });

  it("wires a user plugin under its own namespace", () => {
    const source = buildEslintConfig(
      tool({ config: { groups: ["js"], plugins: [{ pkg: "eslint-plugin-sonarjs", preset: "sonarjs/recommended" }] } }),
      "D:/work/demo",
    );
    expect(source).toContain('import p0Sonarjs from "eslint-plugin-sonarjs"');
    expect(source).toContain('"sonarjs": p0Sonarjs');
  });
});

describe("translate", () => {
  it("falls back to the English key when a language has no entry", () => {
    expect(translate("en", "Run all")).toBe("Run all");
    expect(translate("es", "a sentence nobody translated")).toBe("a sentence nobody translated");
  });

  it("interpolates named variables", () => {
    expect(translate("en", "{n} findings", { n: 3 })).toBe("3 findings");
  });

  it("leaves an unknown placeholder alone rather than printing undefined", () => {
    expect(translate("en", "{n} of {total}", { n: 1 })).toBe("1 of {total}");
  });
});

describe("stackApplies", () => {
  it("lets a language-agnostic tool run anywhere", () => {
    expect(stackApplies([], ["python"])).toBe(true);
  });

  it("runs on an undetected project rather than assuming absence", () => {
    expect(stackApplies(["python"], [])).toBe(true);
  });

  it("keeps a Python linter away from a project with no Python", () => {
    expect(stackApplies(["python"], ["node", "react", "typescript"])).toBe(false);
  });

  it("matches through the alias table, so js/ts still mean node/typescript", () => {
    expect(stackApplies(["js", "ts"], ["typescript"])).toBe(true);
    expect(canonicalTag("TS")).toBe("typescript");
    expect(canonicalTag("golang")).toBe("go");
  });

  it("leaves a tag it has never heard of alone", () => {
    expect(canonicalTag("Elixir")).toBe("elixir");
    expect(stackApplies(["elixir"], ["node"])).toBe(false);
  });
});

describe("buildGitleaksConfig", () => {
  const source = buildGitleaksConfig();

  it("keeps every built-in rule", () => {
    expect(source).toContain("useDefault = true");
  });

  it("walks past build output, which is where the false criticals came from", () => {
    // src-tauri/target/debug/deps/*.rmeta reported as a Generic API Key
    expect(source).toContain("'(^|/)target/',");
    expect(source).toContain("'(^|/)node_modules/',");
    expect(source).toContain("'(^|/)dist/',");
  });

  it("escapes the dot in a dotted directory instead of matching any character", () => {
    expect(source).toContain("'(^|/)\\.git/',");
  });
});

describe("applyFixLimit", () => {
  const findings = [1, 2, 3, 4, 5];

  it("sends at most the batch the user chose", () => {
    expect(applyFixLimit(findings, 2)).toEqual([1, 2]);
  });

  it("treats zero as no limit rather than as nothing", () => {
    expect(applyFixLimit(findings, 0)).toEqual(findings);
  });
});

describe("terminal commands", () => {
  const bash: ShellSpec = { program: "bash.exe", label: "Git Bash", family: "bash" };
  const pwsh: ShellSpec = { program: "pwsh.exe", label: "PowerShell", family: "powershell" };
  const cmd: ShellSpec = { program: "cmd.exe", label: "cmd", family: "cmd" };
  // the prompt that used to break it: MSYS2 ate the escaped quote and bash
  // died with "unexpected EOF while looking for matching `''"
  const prompt = 'Run the "audit" skill.\nGoal: don\'t break it';

  it("reads the prompt out of the environment instead of quoting it in", () => {
    expect(agentCommand(bash, "claude", prompt)).toBe('claude "$ASSAY_PROMPT"');
    expect(agentCommand(pwsh, "claude", prompt)).toBe("claude $env:ASSAY_PROMPT");
    expect(agentCommand(cmd, "claude", prompt)).toBe('claude "%ASSAY_PROMPT%"');
  });

  it("never puts the prompt itself in the command line", () => {
    for (const shell of [bash, pwsh, cmd]) {
      expect(agentCommand(shell, "claude", prompt)).not.toContain("don't");
    }
  });

  it("starts an agent found outside PATH by its full path, in each shell's own way", () => {
    const exe = "C:\\Users\\me\\.opencode\\bin\\opencode.exe";
    expect(agentCommand(bash, "opencode", undefined, exe)).toBe("C:/Users/me/.opencode/bin/opencode.exe");
    expect(agentCommand(pwsh, "opencode", undefined, exe)).toBe(exe);
    expect(agentCommand(bash, "opencode", prompt, exe)).toBe(
      'C:/Users/me/.opencode/bin/opencode.exe run "$ASSAY_PROMPT"',
    );
    const spaced = "C:\\Users\\Jo Doe\\.opencode\\bin\\opencode.exe";
    expect(binForShell(bash, spaced)).toBe("'C:/Users/Jo Doe/.opencode/bin/opencode.exe'");
    expect(binForShell(pwsh, spaced)).toBe(`& '${spaced}'`);
    expect(binForShell(cmd, spaced)).toBe(`"${spaced}"`);
  });

  it("starts the agent bare when there is no prompt, and the shell as itself", () => {
    expect(agentCommand(bash, "claude")).toBe("claude");
    expect(agentCommand(bash, "claude", "   ")).toBe("claude");
    expect(agentCommand(bash, "opencode", prompt)).toBe('opencode run "$ASSAY_PROMPT"');
    expect(agentCommand(bash, "shell", prompt)).toBeUndefined();
  });

  it("gives Claude the Stop hook through a settings path read from the environment", () => {
    expect(agentCommand(bash, "claude", prompt, undefined, { hooks: true })).toBe(
      'claude --settings "$ASSAY_CLAUDE_SETTINGS" "$ASSAY_PROMPT"',
    );
    expect(agentCommand(pwsh, "claude", undefined, undefined, { hooks: true })).toBe(
      "claude --settings $env:ASSAY_CLAUDE_SETTINGS",
    );
    expect(agentCommand(cmd, "claude", undefined, undefined, { hooks: true })).toBe(
      'claude --settings "%ASSAY_CLAUDE_SETTINGS%"',
    );
    // only Claude has the hook; the flag would make another agent refuse to start
    expect(agentCommand(bash, "opencode", undefined, undefined, { hooks: true })).toBe("opencode");
  });

  it("hands the prompt to the child untouched", () => {
    expect(promptEnv(bash, prompt)).toEqual({ ASSAY_PROMPT: prompt });
    expect(promptEnv(pwsh, prompt)).toEqual({ ASSAY_PROMPT: prompt });
    expect(promptEnv(bash, "  ")).toBeUndefined();
  });

  it("flattens it only for cmd, which expands %VAR% into the command line", () => {
    const value = promptEnv(cmd, prompt)?.ASSAY_PROMPT ?? "";
    expect(value).not.toContain("\n");
    expect(value).not.toContain('"');
    expect(value).toContain("don't");
  });
});

describe("dropped paths", () => {
  const bash: ShellSpec = { program: "bash.exe", label: "Git Bash", family: "bash" };
  const cwd = "D:\\projects\\assay";

  it("writes a path inside the project as a relative one, with forward slashes", () => {
    expect(terminalPath(cwd, "D:\\projects\\assay\\src\\lib\\runner.ts")).toBe("src/lib/runner.ts");
  });

  it("keeps a path from elsewhere absolute", () => {
    expect(terminalPath(cwd, "C:\\other\\notes.md")).toBe("C:/other/notes.md");
  });

  it("quotes only what a shell would misread, and leaves room to keep typing", () => {
    expect(droppedPathText(bash, cwd, ["D:\\projects\\assay\\src\\App.tsx"])).toBe("src/App.tsx ");
    expect(droppedPathText(bash, cwd, ["D:\\projects\\assay\\my notes.md"])).toBe("'my notes.md' ");
  });

  it("puts several files on one line and never a newline", () => {
    const text = droppedPathText(bash, cwd, [
      "D:\\projects\\assay\\a.ts",
      "D:\\projects\\assay\\b.ts",
    ]);
    expect(text).toBe("a.ts b.ts ");
    expect(text).not.toContain("\n");
  });
});

describe("clipboardPathText", () => {
  it("hands a text field the path with forward slashes", () => {
    expect(clipboardPathText(["C:\\Users\\me\\AppData\\Local\\Temp\\assay-paste-1-0.png"])).toBe(
      "C:/Users/me/AppData/Local/Temp/assay-paste-1-0.png",
    );
  });

  it("does not quote a space: no shell reads this one", () => {
    expect(clipboardPathText(["D:\\my notes\\shot.png"])).toBe("D:/my notes/shot.png");
  });

  it("separates several paths with a space", () => {
    expect(clipboardPathText(["D:\\a.png", "D:\\b.png"])).toBe("D:/a.png D:/b.png");
  });
});

describe("graphify", () => {
  const graph = (groups?: string[]): Tool =>
    tool({ id: "graphify", name: "Graphify", adapter: "graphify", config: groups ? { groups, plugins: [] } : null });

  it("defaults to the run that needs no key and no network", () => {
    expect(graphifyTokens(graph([]), "build", "D:/repo")).toEqual([
      "graphify",
      "extract",
      "D:/repo",
      "--code-only",
    ]);
  });

  it("rebuild is the same full extraction as build", () => {
    expect(graphifyTokens(graph([]), "rebuild", "/r")).toEqual(graphifyTokens(graph([]), "build", "/r"));
  });

  it("drops --code-only only when the user asked for docs", () => {
    expect(graphifyTokens(graph(["docs"]), "build", "/r")).toEqual(["graphify", "extract", "/r"]);
  });

  it("passes the options through, and update ignores the ones it has no use for", () => {
    expect(graphifyTokens(graph(["deep", "directed", "no-cluster"]), "build", "/r")).toEqual([
      "graphify",
      "extract",
      "/r",
      "--code-only",
      "--mode",
      "deep",
      "--directed",
      "--no-cluster",
    ]);
    expect(graphifyTokens(graph(["deep", "directed", "no-cluster"]), "update", "/r")).toEqual([
      "graphify",
      "update",
      "/r",
      "--no-cluster",
    ]);
  });

  it("keeps a path with spaces in one argument", () => {
    expect(graphifyTokens(graph([]), "update", "D:/my repo")[2]).toBe("D:/my repo");
  });

  it("writes nothing beyond the graph unless an artifact was asked for", () => {
    expect(artifactCommands(graph([]), "/r")).toEqual([]);
    expect(graphifyCommandLines(graph([]), "build", "/r")).toEqual([
      "graphify extract /r --code-only",
    ]);
  });

  it("asks cluster-only once for the report, since it writes graph.html on its way", () => {
    expect(artifactCommands(graph(["report", "html"]), "/r")).toEqual([
      ["graphify", "cluster-only", "/r"],
    ]);
    // the page on its own is the export, and never --no-viz, which deletes it
    expect(artifactCommands(graph(["html"]), "/r")).toEqual([["graphify", "export", "html"]]);
  });

  it("recognises what is in graphify-out, and the call flow by its suffix", () => {
    expect(artifactOf("graph.html")).toBe("html");
    expect(artifactOf("GRAPH_TREE.html")).toBe("tree");
    expect(artifactOf("GRAPH_REPORT.md")).toBe("report");
    // graphify names this one after the project folder, whatever that is called
    expect(artifactOf("assay-callflow.html")).toBe("callflow");
    expect(artifactOf("graph.json")).toBeNull();
    expect(artifactOf("manifest.json")).toBeNull();
  });

  it("runs the extraction first, then each page the options asked for", () => {
    expect(graphifyCommandLines(graph(["report", "tree", "callflow"]), "update", "/r")).toEqual([
      "graphify update /r",
      "graphify cluster-only /r",
      "graphify tree",
      "graphify export callflow-html",
    ]);
  });

  it("installs through the manager with the smallest blast radius, and never a bare pip", () => {
    expect(installCommandFor({ uv: true, pipx: true, pip: true })?.manager).toBe("uv");
    expect(installCommandFor({ uv: false, pipx: true, pip: true })?.manager).toBe("pipx");
    expect(installCommandFor({ uv: false, pipx: false, pip: true })?.tokens).toEqual([
      "pip",
      "install",
      "--user",
      "--upgrade",
      "graphifyy",
    ]);
    expect(installCommandFor({ uv: false, pipx: false, pip: false })).toBeNull();
  });

  it("reports the graph that was actually written — the last count it printed", () => {
    const out = [
      "[graphify extract] scanning D:/repo",
      "AST: 900 nodes, 700 edges",
      "[graphify extract] wrote graphify-out/graph.json — 1,204 nodes, 3,910 edges",
    ].join("\n");
    expect(parseGraphSummary(out)).toBe("1,204 nodes · 3,910 edges");
  });

  it("falls back to the last line when there is no count", () => {
    expect(parseGraphSummary("No files changed since last run. Nothing to update.\n")).toBe(
      "No files changed since last run. Nothing to update.",
    );
    expect(parseGraphSummary("   \n")).toBeUndefined();
  });

  it("adds an extra to the package spec, and re-runs the install that is already there", () => {
    expect(installCommandFor({ uv: true, pipx: false, pip: false }, ["sql"])?.tokens).toEqual([
      "uv",
      "tool",
      "install",
      "--upgrade",
      "graphifyy[sql]",
    ]);
    // pipx refuses to install over itself, so adding an extra is a reinstall
    expect(installCommandFor({ uv: false, pipx: true, pip: true }, ["sql"])?.tokens).toEqual([
      "pipx",
      "install",
      "--force",
      "graphifyy[sql]",
    ]);
    expect(installCommandFor({ uv: false, pipx: false, pip: true }, ["sql"])?.tokens).toEqual([
      "pip",
      "install",
      "--user",
      "--upgrade",
      "graphifyy[sql]",
    ]);
  });
});

describe("graphify agent skills", () => {
  const skill = (over: Partial<AgentSkill> = {}): AgentSkill => ({
    id: "claude",
    label: "Claude Code",
    dir: "/home/me/.claude/skills/graphify",
    installed: true,
    version: "0.9.56",
    ...over,
  });

  it("reads the version graphify answers with, not the ones its warnings quote", () => {
    const out = [
      "  warning: skill at C:/Users/me/.claude/skills/graphify is from graphify 0.9.13, package is 0.9.56.",
      "graphify 0.9.56",
    ].join("\n");
    expect(parseGraphifyVersion(out)).toBe("0.9.56");
    expect(parseGraphifyVersion("command not found")).toBeNull();
  });

  it("compares the stamp on disk with the package that would write it", () => {
    expect(skillStanding(skill(), "0.9.56")).toBe("current");
    expect(skillStanding(skill({ version: "0.9.13" }), "0.9.56")).toBe("stale");
    expect(skillStanding(skill({ installed: false, version: null }), "0.9.56")).toBe("missing");
    // written by a graphify old enough not to stamp itself, or nothing to compare against
    expect(skillStanding(skill({ version: null }), "0.9.56")).toBe("unknown");
    expect(skillStanding(skill(), null)).toBe("unknown");
  });

  it("counts only the skills that are behind — an agent you do not use is not a problem", () => {
    const skills = [
      skill({ id: "claude", version: "0.9.13" }),
      skill({ id: "opencode", version: "0.9.13" }),
      skill({ id: "hermes", installed: false, version: null }),
      skill({ id: "agents" }),
    ];
    expect(staleSkillCount(skills, "0.9.56")).toBe(2);
    expect(staleSkillCount(skills, null)).toBe(0);
  });

  it("installs one platform at a time, which is all the CLI does", () => {
    expect(agentInstallTokens("opencode")).toEqual(["graphify", "install", "--platform", "opencode"]);
  });
});

describe("text engine", () => {
  it("an empty setting means the agentic engine, so nothing changes for anyone who ignores it", () => {
    expect(parseTextEngine("")).toEqual({ kind: "agentic" });
    expect(parseTextEngine(null)).toEqual({ kind: "agentic" });
  });

  it("keeps a model id that contains colons in one piece", () => {
    expect(parseTextEngine("local:ollama:qwen2.5-coder:7b")).toEqual({
      kind: "local",
      runtime: "ollama",
      model: "qwen2.5-coder:7b",
    });
  });

  it("round-trips through the stored string", () => {
    for (const v of ["", "opencode", "local:lmstudio:qwen/qwen3-4b"]) {
      expect(textEngineValue(parseTextEngine(v))).toBe(v);
    }
  });

  it("falls back to agentic rather than trusting a value it does not recognise", () => {
    expect(parseTextEngine("gpt-9")).toEqual({ kind: "agentic" });
    expect(parseTextEngine("local:cursed:x")).toEqual({ kind: "agentic" });
    expect(parseTextEngine("local:ollama")).toEqual({ kind: "agentic" });
    expect(parseTextEngine("local:ollama:")).toEqual({ kind: "agentic" });
  });

  it("names the engine a button has to show", () => {
    expect(textEngineLabel({ kind: "agentic" }, "claude")).toBe("claude");
    expect(textEngineLabel({ kind: "provider", provider: "opencode" }, "claude")).toBe("opencode");
    expect(textEngineLabel({ kind: "local", runtime: "ollama", model: "qwen" }, "claude")).toBe(
      "ollama · qwen",
    );
  });
});

describe("project tags", () => {
  const tag = (id: string, name: string, color = "violet"): Tag => ({
    id,
    name,
    color: color as Tag["color"],
    created_at: 0,
    updated_at: 0,
  });
  const project = (id: string, tags: string[]): Project => ({
    id,
    name: id,
    path: `D:/${id}`,
    url: null,
    stack: [],
    tags,
    authorized: false,
    created_at: 0,
    updated_at: 0,
  });

  const tags = [tag("t1", "frontend"), tag("t2", "client", "amber"), tag("t3", "unused", "teal")];
  const projects = [project("a", ["t1"]), project("b", ["t1", "t2"]), project("c", [])];

  it("resolves a colour to its token, and an unknown one to the neutral", () => {
    expect(tagColorVar("amber")).toBe("var(--color-tag-amber)");
    expect(tagColorVar("#ff0000")).toBe("var(--color-tag-slate)");
    expect(tagColorVar(null)).toBe("var(--color-tag-slate)");
  });

  it("several tags mean OR, because an AND of categories is always empty", () => {
    expect(filterByTags(projects, ["t1", "t2"]).map((p) => p.id)).toEqual(["a", "b"]);
    expect(filterByTags(projects, ["t2"]).map((p) => p.id)).toEqual(["b"]);
    expect(filterByTags(projects, []).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("lists a project under every tag it has, drops empty sections, and puts untagged last", () => {
    const groups = groupByTag(projects, tags);
    expect(groups.map((g) => [g.tag?.name ?? "(none)", g.projects.map((p) => p.id)])).toEqual([
      ["frontend", ["a", "b"]],
      ["client", ["b"]],
      ["(none)", ["c"]],
    ]);
  });

  it("while filtering, only the picked tags get a section and untagged is not one", () => {
    const groups = groupByTag(filterByTags(projects, ["t2"]), tags, ["t2"]);
    expect(groups).toHaveLength(1);
    expect(groups[0].tag?.name).toBe("client");
  });

  it("refuses a duplicate name whatever its case, but not the tag's own name", () => {
    expect(tagNameError("Frontend", tags)).toBe("There is already a tag with that name.");
    expect(tagNameError("  ", tags)).toBe("A tag needs a name.");
    expect(tagNameError("frontend", tags, "t1")).toBeNull();
    expect(tagNameError("backend", tags)).toBeNull();
  });

  it("normalizes what gets stored", () => {
    expect(normalizeTagName("  side   project  ")).toBe("side project");
    expect(normalizeTagName("x".repeat(40))).toHaveLength(24);
  });

  it("counts the projects a tag would come off", () => {
    expect(tagUsage("t1", projects)).toBe(2);
    expect(tagUsage("t3", projects)).toBe(0);
  });
});

describe("project order and activity", () => {
  const project = (id: string, created_at: number, last_used_at: number | null = null): Project => ({
    id,
    name: id,
    path: `D:/${id}`,
    url: null,
    stack: [],
    tags: [],
    authorized: false,
    created_at,
    updated_at: 0,
    last_used_at,
  });

  it("puts the last worked-on project first and the never-used ones after, newest added first", () => {
    const list = [project("old-unused", 1), project("used-later", 2, 200), project("new-unused", 3), project("used-first", 4, 100)];
    expect(sortByLastUse(list).map((p) => p.id)).toEqual(["used-later", "used-first", "new-unused", "old-unused"]);
  });

  it("does not reorder the input", () => {
    const list = [project("a", 1), project("b", 2, 5)];
    sortByLastUse(list);
    expect(list.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("puts the projects with something going first, each half in the order it came", () => {
    const list = [project("a", 1), project("b", 2), project("c", 3), project("d", 4)];
    expect(activeFirst(list, "c,a").map((p) => p.id)).toEqual(["a", "c", "b", "d"]);
    expect(activeFirst(list, "")).toBe(list);
  });

  it("names the active projects as one stable key", () => {
    const runs = [
      { projectId: "b", status: "running" },
      { projectId: "z", status: "done" },
    ];
    const terminals = [
      { projectId: "a", alive: true },
      { projectId: "b", alive: true },
      { projectId: "c", alive: false },
      { projectId: null, alive: true },
    ];
    expect(activeProjectKey(runs, terminals)).toBe("a,b");
    expect(activeProjectKey([], [])).toBe("");
  });

  it("counts only what is still going, in that project", () => {
    const runs = [
      { projectId: "a", status: "running" },
      { projectId: "a", status: "done" },
      { projectId: "b", status: "running" },
    ];
    const terminals = [
      { projectId: "a", alive: true },
      { projectId: "a", alive: false },
      { projectId: null, alive: true },
    ];
    expect(activityOf(runs, terminals, "a")).toEqual({ runs: 1, terminals: 1 });
    expect(activityOf(runs, terminals, "b")).toEqual({ runs: 1, terminals: 0 });
    expect(activityOf(runs, terminals, "c")).toEqual({ runs: 0, terminals: 0 });
  });

  it("says what is active in words, and nothing when nothing is", () => {
    const t = (key: string, vars?: Record<string, string | number>) =>
      key.replace("{n}", String(vars?.n ?? ""));
    expect(activityLabel({ runs: 1, terminals: 2 }, t)).toBe("1 run · 2 terminals");
    expect(activityLabel({ runs: 3, terminals: 0 }, t)).toBe("3 runs");
    expect(activityLabel({ runs: 0, terminals: 1 }, t)).toBe("1 terminal");
    expect(activityLabel({ runs: 0, terminals: 0 }, t)).toBe("");
  });
});

describe("AI choice", () => {
  it("round-trips agents with and without a model, and local models", () => {
    for (const v of [
      "agent:claude",
      "agent:opencode:minimax/MiniMax-M2.5",
      "agent:opencode:lmstudio/qwen/qwen3-coder-30b",
      "local:ollama:qwen2.5-coder:7b",
    ]) {
      const choice = parseAIChoice(v);
      expect(choice).not.toBeNull();
      if (choice) expect(aiChoiceValue(choice)).toBe(v);
    }
  });

  it("keeps the model's own colons and slashes in one piece", () => {
    expect(parseAIChoice("local:ollama:qwen2.5-coder:7b")).toEqual({
      kind: "local",
      runtime: "ollama",
      model: "qwen2.5-coder:7b",
    });
    expect(parseAIChoice("agent:hermes:anthropic/claude-sonnet-4")).toEqual({
      kind: "agent",
      provider: "hermes",
      model: "anthropic/claude-sonnet-4",
    });
  });

  it("refuses what it does not recognise instead of trusting it", () => {
    for (const v of ["", "claude", "agent:gpt", "local:ollama", "local:ollama:", "local:cursed:x", "status:ollama"]) {
      expect(parseAIChoice(v)).toBeNull();
    }
  });

  it("names the engine for a button", () => {
    expect(aiChoiceLabel({ kind: "agent", provider: "claude", model: "" })).toBe("claude");
    expect(aiChoiceLabel({ kind: "agent", provider: "opencode", model: "minimax/M2" })).toBe("opencode · minimax/M2");
    expect(aiChoiceLabel({ kind: "local", runtime: "lmstudio", model: "qwen" })).toBe("LM Studio · qwen");
  });
});

describe("AI options", () => {
  const found = (id: "claude" | "opencode" | "hermes", command: string | null) => ({
    id,
    command,
    source: command ? ("path" as const) : null,
  });
  const inventory: AIInventory = {
    agents: { claude: found("claude", "claude"), opencode: found("opencode", "opencode"), hermes: found("hermes", null) },
    opencodeModels: ["minimax/MiniMax-M2", "lmstudio/qwen/qwen3-coder-30b", "ollama/llama3"],
    hermesModels: [],
    hermes: { model: null, usable: false },
    runtimes: [
      {
        runtime: "ollama",
        label: "Ollama",
        url: "http://localhost:11434",
        chatUrl: "",
        online: false,
        models: [],
        hint: "",
        installed: true,
      },
      {
        runtime: "lmstudio",
        label: "LM Studio",
        url: "http://localhost:1234",
        chatUrl: "",
        online: true,
        models: ["qwen/qwen3-4b"],
        hint: "",
        installed: true,
      },
    ],
  };

  it("lists opencode's local models only while their runtime is running", () => {
    const fix = aiOptions(inventory, "fix");
    expect(fix.some((o) => o.value === "agent:opencode:lmstudio/qwen/qwen3-coder-30b")).toBe(true);
    expect(fix.some((o) => o.value === "agent:opencode:ollama/llama3")).toBe(false);
  });

  it("offers a bare local model for text, and leaves it out of anything that edits files", () => {
    const value = "local:lmstudio:qwen/qwen3-4b";
    expect(aiOptions(inventory, "commit").some((o) => o.value === value)).toBe(true);
    expect(aiOptions(inventory, "fix").some((o) => o.value === value)).toBe(false);
  });

  it("groups each model under the agent that runs it", () => {
    const options = aiOptions(inventory, "commit");
    expect(options.find((o) => o.value === "agent:opencode:minimax/MiniMax-M2")).toMatchObject({
      group: "OpenCode",
      label: "minimax/MiniMax-M2",
    });
    expect(options.find((o) => o.value === "agent:claude")?.group).toBe("Claude");
  });

  it("lists Hermes only when something can answer for it, with its own default first", () => {
    const withHermes: AIInventory = {
      ...inventory,
      agents: { ...inventory.agents, hermes: found("hermes", "hermes") },
      hermesModels: ["anthropic/claude-opus-4.6", "openai/gpt-5"],
    };
    const blocked = { ...withHermes, hermes: { model: "anthropic/claude-opus-4.6", usable: false } };
    expect(aiOptions(blocked, "commit").some((o) => o.group === "Hermes")).toBe(false);
    const ready = { ...withHermes, hermes: { model: "anthropic/claude-opus-4.6", usable: true } };
    expect(aiOptions(ready, "commit").filter((o) => o.group === "Hermes").map((o) => o.label)).toEqual([
      "anthropic/claude-opus-4.6",
      "openai/gpt-5",
    ]);
  });

  it("reads hermes status: a model name alone is not a way to reach it", () => {
    const none = [
      "◆ Environment",
      "  Model:        anthropic/claude-opus-4.6",
      "◆ API Keys",
      "  OpenRouter    ✗ (not set)",
      "  GitHub        ✓ ghp_…",
      "◆ Auth Providers",
      "  Nous Portal   ✗ not logged in (run: hermes portal)",
      "◆ Messaging Platforms",
      "  A2A           ✓ configured (plugin)",
    ].join("\n");
    expect(parseHermesStatus(none)).toEqual({ model: "anthropic/claude-opus-4.6", usable: false });
    expect(parseHermesStatus(none.replace("OpenRouter    ✗ (not set)", "OpenRouter    ✓ sk-or-…")).usable).toBe(true);
    expect(isLocalEndpoint("http://localhost:11434/v1")).toBe(true);
    expect(isLocalEndpoint("https://openrouter.ai/api/v1")).toBe(false);
  });

  it("leaves out a missing agent and a stopped runtime", () => {
    const options = aiOptions(inventory, "commit");
    expect(options.some((o) => o.value === "agent:hermes")).toBe(false);
    expect(options.some((o) => o.value.startsWith("status:") || o.value.startsWith("local:ollama"))).toBe(false);
    expect(options.every((o) => !o.disabled)).toBe(true);
  });
});

describe("agent binaries", () => {
  const dirs = {
    home: "C:\\Users\\me",
    localData: "C:\\Users\\me\\AppData\\Local",
    roaming: "C:\\Users\\me\\AppData\\Roaming",
  };

  it("looks where opencode's installer puts it, which only Git Bash has on PATH", () => {
    expect(knownBinPaths("opencode", true, dirs)[0]).toBe("C:/Users/me/.opencode/bin/opencode.exe");
  });

  it("finds hermes, ollama and lms in their own homes", () => {
    expect(knownBinPaths("hermes", true, dirs)).toContain("C:/Users/me/AppData/Local/hermes/bin/hermes.exe");
    expect(knownBinPaths("ollama", true, dirs)).toContain("C:/Users/me/AppData/Local/Programs/Ollama/ollama.exe");
    expect(knownBinPaths("lms", true, dirs)).toContain("C:/Users/me/.lmstudio/bin/lms.exe");
  });

  it("uses Unix homes elsewhere", () => {
    expect(knownBinPaths("opencode", false, { home: "/home/me", localData: "", roaming: "" })[0]).toBe(
      "/home/me/.opencode/bin/opencode",
    );
  });
});

describe("install recipes", () => {
  const all: Managers = { npm: true, winget: true, brew: true, uv: true, pipx: true };
  const none: Managers = { npm: false, winget: false, brew: false, uv: false, pipx: false };

  it("installs the npm-published agents with npm", () => {
    expect(installRecipe("opencode", "windows", all)).toEqual({
      kind: "command",
      tokens: ["npm", "install", "-g", "opencode-ai"],
    });
    expect(installRecipe("claude", "macos", all)).toEqual({
      kind: "command",
      tokens: ["npm", "install", "-g", "@anthropic-ai/claude-code"],
    });
  });

  it("never runs a script piped into a shell, and never Docker Desktop's installer", () => {
    expect(installRecipe("hermes", "linux", all).kind).toBe("manual");
    expect(installRecipe("hermes", "windows", all).kind).toBe("manual");
    expect(installRecipe("docker", "windows", all)).toMatchObject({ kind: "manual" });
  });

  it("uses winget on Windows and brew on macOS for the rest", () => {
    expect(installRecipe("ollama", "windows", all)).toEqual({
      kind: "command",
      tokens: ["winget", "install", "-e", "--id", "Ollama.Ollama", "--accept-source-agreements", "--accept-package-agreements"],
    });
    expect(installRecipe("lmstudio", "macos", all)).toEqual({ kind: "command", tokens: ["brew", "install", "--cask", "lm-studio"] });
  });

  it("prefers uv, then pipx, for strix", () => {
    expect(installRecipe("strix", "linux", all)).toEqual({ kind: "command", tokens: ["uv", "tool", "install", "strix-agent"] });
    expect(installRecipe("strix", "linux", { ...none, pipx: true })).toEqual({ kind: "command", tokens: ["pipx", "install", "strix-agent"] });
  });

  it("falls back to a link and the command to copy when no package manager can do it", () => {
    expect(installRecipe("opencode", "windows", none)).toMatchObject({ kind: "manual", command: "npm install -g opencode-ai" });
    expect(installRecipe("git", "linux", all)).toMatchObject({ kind: "manual" });
  });
});

describe("claude limits", () => {
  it("says the time to a reset in the fewest characters", () => {
    expect(shortUntil(30_000)).toBe("<1m");
    expect(shortUntil(45 * 60_000)).toBe("45m");
    expect(shortUntil(130 * 60_000)).toBe("2h 10m");
    expect(shortUntil(120 * 60_000)).toBe("2h");
  });

  it("only colours a percentage once it matters", () => {
    expect(usageTone(79)).toBeNull();
    expect(usageTone(80)).toBe("warn");
    expect(usageTone(95)).toBe("danger");
  });

  it("treats a window past its reset as reset, not as its old percentage", () => {
    expect(windowElapsed({ usedPercentage: 90, resetsAt: 100 }, 100_000)).toBe(true);
    expect(windowElapsed({ usedPercentage: 90, resetsAt: 101 }, 100_000)).toBe(false);
  });
});

describe("project scripts", () => {
  it("runs a script the way its lockfile's manager does", () => {
    expect(managerFrom(["package-lock.json", "pnpm-lock.yaml"])).toBe("pnpm");
    expect(managerFrom(["bun.lockb"])).toBe("bun");
    expect(managerFrom([])).toBe("npm");
    expect(runScript("npm", "dev")).toBe("npm run dev");
    expect(runScript("pnpm", "dev")).toBe("pnpm dev");
  });

  it("keeps only real scripts from package.json or composer.json", () => {
    expect(scriptNames({ scripts: { dev: "vite", test: ["phpunit"], bad: 3 } })).toEqual(["dev", "test"]);
    expect(scriptNames(null)).toEqual([]);
  });

  it("lists the Makefile targets a person would run", () => {
    const make = [".PHONY: build", "CC := gcc", "build: deps", "\t$(CC) main.c", "%.o: %.c", "_internal:", "dev:", "build:"].join("\n");
    expect(makeTargets(make)).toEqual(["build", "dev"]);
  });

  it("keeps the tab alive after Ctrl+C in bash, and reads the line from the environment", () => {
    const bash = { program: "bash", label: "Git Bash", family: "bash" } as const;
    expect(scriptShellCommand(bash)).toBe('trap : INT; eval "$ASSAY_COMMAND"; trap - INT');
    expect(scriptShellCommand({ program: "pwsh", label: "pwsh", family: "powershell" })).toBe(
      "Invoke-Expression $env:ASSAY_COMMAND",
    );
  });
});

describe("tab order", () => {
  const keys: TabKey[] = ["t:a", "t:b", "f:/x.ts", "f:/y.ts"];

  it("puts placed tabs in the user's order and never-moved ones last, as opened", () => {
    expect(orderTabs(keys, ["f:/y.ts", "t:a", "t:gone"])).toEqual(["f:/y.ts", "t:a", "t:b", "f:/x.ts"]);
  });

  it("drops a tab where the pointer released it, either direction", () => {
    expect(moveTab(keys, "t:a", "f:/x.ts")).toEqual(["t:b", "f:/x.ts", "t:a", "f:/y.ts"]);
    expect(moveTab(keys, "f:/y.ts", "t:b")).toEqual(["t:a", "f:/y.ts", "t:b", "f:/x.ts"]);
    expect(moveTab(keys, "t:a", "t:missing")).toBe(keys);
  });

  it("nudges one place and stays put at the ends", () => {
    expect(nudgeTab(keys, "t:b", -1)).toEqual(["t:b", "t:a", "f:/x.ts", "f:/y.ts"]);
    expect(nudgeTab(keys, "t:a", -1)).toBe(keys);
    expect(nudgeTab(keys, "f:/y.ts", 1)).toBe(keys);
  });

  it("stores one project's arrangement without touching another's keys", () => {
    expect(storeOrder(["t:other", "t:a", "t:b"], ["t:b", "t:a"])).toEqual(["t:other", "t:b", "t:a"]);
  });
});

describe("remote web url", () => {
  it("turns ssh remotes into the https page", () => {
    expect(webUrlFromRemote("git@github.com:me/assay.git")).toBe("https://github.com/me/assay");
    expect(webUrlFromRemote("ssh://git@gitlab.com:2222/team/app.git")).toBe("https://gitlab.com/team/app");
  });

  it("never lets credentials from an https remote through", () => {
    expect(webUrlFromRemote("https://me:ghp_secret@github.com/me/assay.git\n")).toBe("https://github.com/me/assay");
    expect(webUrlFromRemote("https://oauth2:tok@gitlab.com/team/app")).toBe("https://gitlab.com/team/app");
  });

  it("refuses what is not a web page", () => {
    expect(webUrlFromRemote("file:///srv/repos/app.git")).toBeNull();
    expect(webUrlFromRemote("/srv/repos/app.git")).toBeNull();
    expect(webUrlFromRemote("")).toBeNull();
  });
});

describe("git status -z", () => {
  it("keeps paths with spaces and accents verbatim, so they work as pathspecs", () => {
    const out = "## main...origin/main [ahead 2, behind 1]\0 M my file.txt\0?? café.md\0";
    expect(parseStatusZ(out)).toEqual({
      branch: "main",
      ahead: 2,
      behind: 1,
      changes: [
        { code: " M", path: "my file.txt", staged: false, untracked: false },
        { code: "??", path: "café.md", staged: false, untracked: true },
      ],
    });
  });

  it("reads a rename's source from the record after it", () => {
    const out = "## main\0R  new name.ts\0old name.ts\0 D gone.ts\0";
    expect(parseStatusZ(out).changes).toEqual([
      { code: "R ", path: "new name.ts", from: "old name.ts", staged: true, untracked: false },
      { code: " D", path: "gone.ts", staged: false, untracked: false },
    ]);
  });
});

describe("git conflicts", () => {
  const file = [
    "import a from 'a';\n",
    "<<<<<<< HEAD\n",
    "const x = 1;\n",
    "=======\n",
    "const x = 2;\n",
    ">>>>>>> origin/main\n",
    "export { x };\n",
  ].join("");

  it("splits a file into agreed text and clashes, with both labels", () => {
    const segs = parseConflicts(file);
    expect(segs.map((s) => s.kind)).toEqual(["text", "conflict", "text"]);
    expect(segs[1]).toMatchObject({ ours: "const x = 1;\n", theirs: "const x = 2;\n", oursLabel: "HEAD", theirsLabel: "origin/main" });
  });

  it("writes each choice, and keeps the markers of a clash left open", () => {
    const segs = parseConflicts(file);
    expect(resolveConflicts(segs, ["ours"])).toBe("import a from 'a';\nconst x = 1;\nexport { x };\n");
    expect(resolveConflicts(segs, ["theirs"])).toBe("import a from 'a';\nconst x = 2;\nexport { x };\n");
    expect(resolveConflicts(segs, ["both"])).toBe("import a from 'a';\nconst x = 1;\nconst x = 2;\nexport { x };\n");
    expect(resolveConflicts(segs, [null])).toBe(file);
    expect(hasConflictMarkers(resolveConflicts(segs, [null]))).toBe(true);
  });

  it("reads the diff3 base apart from both sides", () => {
    const segs = parseConflicts("<<<<<<< ours\na\n||||||| base\no\n=======\nb\n>>>>>>> theirs\n");
    expect(segs[0]).toMatchObject({ kind: "conflict", ours: "a\n", base: "o\n", theirs: "b\n" });
  });

  it("keeps a block that never closes as text rather than dropping it", () => {
    const broken = "x\n<<<<<<< HEAD\ny\n";
    expect(parseConflicts(broken)).toEqual([{ kind: "text", text: broken }]);
    expect(hasConflictMarkers(broken)).toBe(false);
  });

  it("does not take a longer run of the same character for a marker", () => {
    expect(hasConflictMarkers("<<<<<<<<< not a marker\n=======\n>>>>>>>\n")).toBe(false);
  });
});

describe("git errors in plain words", () => {
  it("tells a rejected push to pull first", () => {
    const out = " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs";
    expect(explainGitError(out)).toMatch(/Pull first/);
  });

  it("names uncommitted changes that a pull would overwrite", () => {
    expect(explainGitError("error: Your local changes to the following files would be overwritten by merge:")).toMatch(
      /uncommitted/,
    );
  });

  it("points a clashing merge to Conflicts", () => {
    expect(explainGitError("CONFLICT (content): Merge conflict in a.ts\nAutomatic merge failed")).toMatch(/Conflicts/);
  });

  it("leaves output it does not recognise to git's own words", () => {
    expect(explainGitError("fatal: something new")).toBeNull();
  });
});

/* ---------------------------------- github ---------------------------------- */

describe("github expiring tokens", () => {
  it("keeps what renews a token and when each half ends", () => {
    const g = grantFrom(
      { access_token: "ghu_a", expires_in: 28800, refresh_token: "ghr_b", refresh_token_expires_in: 15897600 },
      1_000,
    );
    expect(g).toEqual({
      token: "ghu_a",
      refreshToken: "ghr_b",
      expiresAt: 1_000 + 28_800_000,
      refreshExpiresAt: 1_000 + 15_897_600_000,
    });
  });

  it("renews shortly before the end, never a token that does not expire", () => {
    expect(needsRenewal({ refreshToken: "r", expiresAt: 10 * 60_000 }, 0)).toBe(false);
    expect(needsRenewal({ refreshToken: "r", expiresAt: 4 * 60_000 }, 0)).toBe(true);
    expect(needsRenewal({ refreshToken: null, expiresAt: 1 }, 0)).toBe(false);
    expect(needsRenewal({ refreshToken: "r", expiresAt: null }, 0)).toBe(false);
  });
});

const repo = (fullName: string, description = ""): Repo => ({
  id: fullName.length,
  name: fullName.split("/")[1] ?? fullName,
  fullName,
  owner: fullName.split("/")[0] ?? "",
  private: false,
  fork: false,
  archived: false,
  description,
  language: "",
  defaultBranch: "main",
  htmlUrl: `https://github.com/${fullName}`,
  cloneUrl: `https://github.com/${fullName}.git`,
  pushedAt: 0,
});

describe("github device flow answers", () => {
  it("keeps waiting while GitHub says pending, and slows down when told", () => {
    expect(readPollAnswer({ error: "authorization_pending" }, 5)).toEqual({ kind: "wait", interval: 5 });
    expect(readPollAnswer({ error: "slow_down" }, 5)).toEqual({ kind: "wait", interval: 10 });
  });
  it("hands back the token and names the final errors", () => {
    expect(readPollAnswer({ access_token: "gho_x" }, 5, 0)).toEqual({
      kind: "token",
      grant: { token: "gho_x", refreshToken: null, expiresAt: null, refreshExpiresAt: null },
    });
    expect(readPollAnswer({ error: "expired_token" }, 5).kind).toBe("fail");
    expect(readPollAnswer({ error: "access_denied" }, 5).kind).toBe("fail");
    expect(readPollAnswer({ error: "weird", error_description: "Something odd" }, 5)).toEqual({
      kind: "fail",
      reason: "Something odd",
    });
  });
});

describe("github pagination", () => {
  it("reads the next page out of the Link header and stops on the last one", () => {
    const link =
      '<https://api.github.com/user/repos?per_page=100&page=3>; rel="next", <https://api.github.com/user/repos?per_page=100&page=7>; rel="last"';
    expect(nextPageOf(link)).toBe(3);
    expect(nextPageOf('<https://api.github.com/user/repos?page=1>; rel="prev"')).toBeNull();
    expect(nextPageOf(null)).toBeNull();
  });
});

describe("github repo filter", () => {
  const repos = [repo("me/assay", "desktop scanner hub"), repo("org/site", "marketing"), repo("me/tools")];
  it("matches every word against owner/name and description, case-insensitively", () => {
    expect(filterRepos(repos, "").length).toBe(3);
    expect(filterRepos(repos, "ME/").map((r) => r.fullName)).toEqual(["me/assay", "me/tools"]);
    expect(filterRepos(repos, "scanner me").map((r) => r.fullName)).toEqual(["me/assay"]);
    expect(filterRepos(repos, "nothing")).toEqual([]);
  });
});

describe("github clone", () => {
  it("joins the destination with the separator the root already uses", () => {
    expect(cloneDestination("C:\\code\\", "assay")).toBe("C:\\code\\assay");
    expect(cloneDestination("/home/me/code/", "assay")).toBe("/home/me/code/assay");
    expect(cloneDestination("D:/vps/code", "assay")).toBe("D:/vps/code/assay");
  });
  it("matches a folder however its path is written", () => {
    expect(samePath("C:\\code\\Assay\\", "c:/code/assay")).toBe(true);
    expect(samePath("D:/vps/code/assay", "D:/other/assay")).toBe(false);
    expect(samePath("/home/me/Assay", "/home/me/assay")).toBe(false);
  });
  it("passes the token through git's config environment, never without the no-prompt guard", () => {
    expect(cloneEnv(null)).toEqual({ GIT_TERMINAL_PROMPT: "0" });
    const env = cloneEnv("gho_secret");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${btoa("x-access-token:gho_secret")}`);
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("gho_secret");
  });
  it("scopes the push and pull header to github.com only", () => {
    const env = remoteAuthEnv("gho_secret");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraHeader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${btoa("x-access-token:gho_secret")}`);
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("gho_secret");
  });
  it("hands the token only to https remotes on github.com", () => {
    expect(isGitHubHttpsRemote("https://github.com/me/assay.git\n")).toBe(true);
    expect(isGitHubHttpsRemote("https://GitHub.com/me/assay")).toBe(true);
    expect(isGitHubHttpsRemote("git@github.com:me/assay.git")).toBe(false);
    expect(isGitHubHttpsRemote("ssh://git@github.com/me/assay.git")).toBe(false);
    expect(isGitHubHttpsRemote("http://github.com/me/assay")).toBe(false);
    expect(isGitHubHttpsRemote("https://gitlab.com/me/assay")).toBe(false);
    expect(isGitHubHttpsRemote("https://github.com.evil.io/me/assay")).toBe(false);
    expect(isGitHubHttpsRemote("")).toBe(false);
  });
});

describe("github owner filter", () => {
  const projects = [
    { id: "a", github_repo: "me/assay" },
    { id: "b", github_repo: "org/site" },
    { id: "c", github_repo: null },
    { id: "d", github_repo: "me/tools" },
    { id: "e", github_repo: "broken" },
  ];
  it("reads the owner out of owner/name and nothing else", () => {
    expect(githubOwnerOf({ github_repo: "me/assay" })).toBe("me");
    expect(githubOwnerOf({ github_repo: null })).toBeNull();
    expect(githubOwnerOf({ github_repo: "broken" })).toBeNull();
  });
  it("lists owners by how many projects they have, then by name", () => {
    expect(githubOwners(projects)).toEqual([
      { owner: "me", count: 2 },
      { owner: "org", count: 1 },
    ]);
  });
  it("narrows to one owner and leaves the list alone with none", () => {
    expect(filterByGithubOwner(projects, "me").map((p) => p.id)).toEqual(["a", "d"]);
    expect(filterByGithubOwner(projects, null).map((p) => p.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(filterByGithubOwner(projects, "nobody")).toEqual([]);
  });
});

/* ---------------------------------- deploy ---------------------------------- */

describe("deploy sftp.json", () => {
  it("reads one config, comments and trailing commas included", () => {
    const [d] = parseSftpJson(`{
      // the extension writes comments
      "name": "prod",
      "host": "example.com",
      "protocol": "sftp",
      "port": 2222,
      "username": "deploy",
      "privateKeyPath": "~/.ssh/id_ed25519", /* inline */
      "remotePath": "/var/www/site",
      "context": "./dist",
      "ignore": [".git", "node_modules",],
    }`);
    expect(d).toMatchObject({
      name: "prod",
      protocol: "sftp",
      host: "example.com",
      port: 2222,
      username: "deploy",
      auth: "key",
      key_path: "~/.ssh/id_ed25519",
      remote_path: "/var/www/site",
      local_dir: "dist",
      excludes: [".git", "node_modules"],
      is_default: true,
      secret: null,
    });
  });
  it("keeps a slash-slash inside a string", () => {
    expect(JSON.parse(stripJsonComments(`{"u": "http://x" // c\n}`))).toEqual({ u: "http://x" });
  });
  it("turns secure FTP into FTPS and moves a written password out for the keychain", () => {
    const [d] = parseSftpJson(JSON.stringify({ host: "ftp.example.com", protocol: "ftp", secure: true, username: "u", password: "p" }));
    expect(d.protocol).toBe("ftps");
    expect(d.port).toBe(21);
    expect(d.auth).toBe("password");
    expect(d.secret).toBe("p");
    expect(d.remote_path).toBe("/");
    expect(d.excludes).toEqual(DEFAULT_EXCLUDES);
  });
  it("makes one server per profile and defaults to the named one", () => {
    const drafts = parseSftpJson(
      JSON.stringify({
        name: "site",
        host: "a.example.com",
        username: "u",
        remotePath: "/srv",
        defaultProfile: "prod",
        profiles: { staging: { remotePath: "/srv/staging" }, prod: { host: "b.example.com" } },
      }),
    );
    expect(drafts.map((d) => [d.name, d.host, d.remote_path, d.is_default])).toEqual([
      ["site · staging", "a.example.com", "/srv/staging", false],
      ["site · prod", "b.example.com", "/srv", true],
    ]);
  });
  it("skips a config with no host and throws on something that is not JSON", () => {
    expect(parseSftpJson(`[{"name":"x"}]`)).toEqual([]);
    expect(() => parseSftpJson("not json")).toThrow();
  });
  it("writes the servers back without any password", () => {
    const server: DeployServer = {
      id: "s",
      project_id: "p",
      name: "prod",
      protocol: "ftps",
      host: "h",
      port: 21,
      username: "u",
      auth: "password",
      key_path: null,
      remote_path: "/www",
      local_dir: "dist",
      excludes: [".git"],
      host_key: null,
      is_default: true,
      auto_upload: false,
      last_deploy_at: null,
      created_at: 0,
    };
    const out = JSON.parse(toSftpJson([server]));
    expect(out).toEqual({
      name: "prod",
      host: "h",
      protocol: "ftp",
      secure: true,
      port: 21,
      username: "u",
      remotePath: "/www",
      uploadOnSave: true,
      context: "./dist",
      ignore: [".git"],
    });
    expect(Array.isArray(JSON.parse(toSftpJson([server, { ...server, id: "t" }])))).toBe(true);
  });
});

describe("deploy helpers", () => {
  it("names a server by where it lands, the port only when it is not the default", () => {
    const base = { username: "deploy", host: "h", protocol: "sftp" as const, remote_path: "/www" };
    expect(serverAddress({ ...base, port: 22 })).toBe("deploy@h:/www");
    expect(serverAddress({ ...base, port: 2222 })).toBe("deploy@h:2222:/www");
    expect(serverAddress({ ...base, username: "", port: 22, remote_path: "" })).toBe("h:~");
  });
  it("reads the exclude box one pattern per line", () => {
    expect(parseExcludes(" .git \r\n\n*.log\n")).toEqual([".git", "*.log"]);
  });
  it("lists uploads by path and keeps deletions apart", () => {
    const f = (path: string) => ({ path, size: 1, mtime: 1, hash: "h" });
    const { uploads, deletions } = changesOf({
      added: [f("b.css")],
      modified: [f("a.php")],
      touched: [f("same.txt")],
      deleted: ["gone.html"],
      files: 3,
    });
    expect(uploads.map((c) => [c.path, c.kind])).toEqual([
      ["a.php", "modified"],
      ["b.css", "added"],
    ]);
    expect(deletions).toEqual([{ path: "gone.html", kind: "deleted" }]);
  });
});
