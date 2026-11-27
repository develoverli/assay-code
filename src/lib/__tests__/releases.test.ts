import { describe, expect, it } from "vitest";
import {
  buildCommitPrompt,
  checkReleasePleaseSubject,
  fixTypeOrder,
  parseSubject,
  resolveStyle,
  styleSettingOf,
} from "@/lib/commit-style";
import { githubRepoFromWebUrl } from "@/lib/github";
import type { GitCommit } from "@/lib/git";
import {
  bumpVersion,
  decideBump,
  DEFAULT_BUMP_RULES,
  groupCommits,
  parseManifest,
  parseReleasePleaseConfig,
  parseVersion,
  releasableCount,
  rootTagOf,
  tagBlocker,
  tagWebUrl,
  validTagName,
  versionFromCargoToml,
  versionFromJson,
  versionMismatches,
} from "@/lib/releases";

const commits = (...subjects: string[]): GitCommit[] =>
  subjects.map((subject, i) => ({ hash: `h${i}`, subject, author: "a", at: 0 }));

describe("commit style", () => {
  it("resolves auto from what the repository carries", () => {
    expect(resolveStyle("auto", true)).toBe("release-please");
    expect(resolveStyle("auto", false)).toBe("gitmoji");
    expect(resolveStyle("gitmoji", true)).toBe("gitmoji");
    expect(resolveStyle("custom", false)).toBe("custom");
  });

  it("reads an unknown or missing stored value as auto", () => {
    expect(styleSettingOf({ commit_style: null })).toBe("auto");
    expect(styleSettingOf({ commit_style: "semantic" })).toBe("auto");
    expect(styleSettingOf({ commit_style: "release-please" })).toBe("release-please");
    expect(styleSettingOf(undefined)).toBe("auto");
  });

  it("puts the diff after the instructions", () => {
    expect(buildCommitPrompt("Do it.\n\n", "diff --git a b")).toBe("Do it.\n\ndiff --git a b");
  });
});

describe("parseSubject", () => {
  it("reads the header in either order", () => {
    expect(parseSubject("feat(remote): ✨ add tunnels")).toMatchObject({
      type: "feat",
      scope: "remote",
      breaking: false,
      emojiFirst: false,
    });
    expect(parseSubject("✨ feat(remote): add tunnels")).toMatchObject({ type: "feat", scope: "remote", emojiFirst: true });
    expect(parseSubject("♻️ refactor: split store")).toMatchObject({ type: "refactor", emojiFirst: true });
    expect(parseSubject(":sparkles: feat: shortcode")).toMatchObject({ type: "feat", emojiFirst: true });
  });

  it("sees a breaking change", () => {
    expect(parseSubject("feat(api)!: drop v1")?.breaking).toBe(true);
  });

  it("returns null without a header", () => {
    expect(parseSubject("update stuff")).toBeNull();
    expect(parseSubject("feat add thing")).toBeNull();
  });
});

describe("checkReleasePleaseSubject / fixTypeOrder", () => {
  it("flags emoji first and a missing type, and leaves the rest alone", () => {
    expect(checkReleasePleaseSubject("✨ feat: x")).toBe("emoji-first");
    expect(checkReleasePleaseSubject("added a thing")).toBe("no-type");
    expect(checkReleasePleaseSubject("feat: ✨ x")).toBe("ok");
    expect(checkReleasePleaseSubject("")).toBe("ok");
    expect(checkReleasePleaseSubject("Merge branch 'main' into dev")).toBe("ok");
    expect(checkReleasePleaseSubject('Revert "feat: x"')).toBe("ok");
  });

  it("moves the emoji after the colon, keeping scope and bang", () => {
    expect(fixTypeOrder("✨ feat(auth): add magic link")).toBe("feat(auth): ✨ add magic link");
    expect(fixTypeOrder("🐛 fix!: stop crash")).toBe("fix!: 🐛 stop crash");
    expect(fixTypeOrder("♻️ refactor: tidy")).toBe("refactor: ♻️ tidy");
  });

  it("leaves a subject with nothing to move unchanged", () => {
    expect(fixTypeOrder("feat: ✨ fine")).toBe("feat: ✨ fine");
    expect(fixTypeOrder("✨ no header here")).toBe("✨ no header here");
  });
});

describe("versions and tags", () => {
  it("parses versions with or without v", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
    expect(parseVersion("0.1.0-beta.1")).toEqual({ major: 0, minor: 1, patch: 0, pre: "beta.1" });
    expect(parseVersion("next")).toBeNull();
  });

  it("takes the newest root tag, skipping package tags", () => {
    expect(rootTagOf(["web-v2.0.0", "v0.2.0", "v0.1.0"])).toMatchObject({ tag: "v0.2.0", prefix: "v" });
    expect(rootTagOf(["1.4.0"])).toMatchObject({ tag: "1.4.0", prefix: "" });
    expect(rootTagOf(["nightly"])).toBeNull();
  });

  it("validates a tag name as a version", () => {
    expect(validTagName("v0.2.1")).toBe(true);
    expect(validTagName("0.2.1")).toBe(true);
    expect(validTagName("release-1")).toBe(false);
  });
});

describe("groupCommits", () => {
  const list = commits(
    "feat(remote): ✨ tunnels",
    "✨ feat: emoji first",
    "fix(ui): 🐛 overflow",
    "perf: faster scan",
    "docs: readme",
    "chore!: drop node 18",
    "wip",
    "Merge branch 'x'",
  );

  it("ignores emoji-first subjects in release-please mode", () => {
    const g = groupCommits(list, "release-please");
    expect(g.features.map((c) => c.commit.subject)).toEqual(["feat(remote): ✨ tunnels"]);
    expect(g.fixes).toHaveLength(2);
    expect(g.other).toHaveLength(2);
    expect(g.ignored.map((c) => c.commit.subject)).toEqual(["✨ feat: emoji first", "wip"]);
    expect(g.breaking).toBe(1);
    // feat + fix + perf + the breaking chore
    expect(releasableCount(g)).toBe(4);
  });

  it("counts both orders when releasing by tag", () => {
    const g = groupCommits(list, "tags");
    expect(g.features).toHaveLength(2);
    expect(g.ignored.map((c) => c.commit.subject)).toEqual(["wip"]);
  });
});

describe("decideBump", () => {
  const v = (s: string) => parseVersion(s);
  const g = (...s: string[]) => groupCommits(commits(...s), "release-please");

  it("follows release-please's default versioning", () => {
    expect(decideBump(g("feat: a"), v("1.2.3"), DEFAULT_BUMP_RULES)).toEqual({ bump: "minor", reason: "feature" });
    expect(decideBump(g("fix: a"), v("1.2.3"), DEFAULT_BUMP_RULES)).toEqual({ bump: "patch", reason: "fix" });
    expect(decideBump(g("feat!: a"), v("1.2.3"), DEFAULT_BUMP_RULES)).toEqual({ bump: "major", reason: "breaking" });
    expect(decideBump(g("docs: a", "chore: b"), v("1.2.3"), DEFAULT_BUMP_RULES)).toBeNull();
  });

  it("applies the pre-1.0 rules only before 1.0", () => {
    const rules = { bumpMinorPreMajor: true, bumpPatchForMinorPreMajor: true };
    expect(decideBump(g("feat: a"), v("0.1.1"), rules)).toEqual({ bump: "patch", reason: "feature-pre-major" });
    expect(decideBump(g("feat!: a"), v("0.1.1"), rules)).toEqual({ bump: "minor", reason: "breaking-pre-major" });
    expect(decideBump(g("feat: a"), v("1.0.0"), rules)).toEqual({ bump: "minor", reason: "feature" });
  });

  it("bumps and drops a pre-release suffix", () => {
    expect(bumpVersion(v("0.1.1"), "patch")).toEqual({ major: 0, minor: 1, patch: 2, pre: null });
    expect(bumpVersion(v("1.2.3-rc.1"), "minor")).toEqual({ major: 1, minor: 3, patch: 0, pre: null });
    expect(bumpVersion(v("1.2.3"), "major")).toEqual({ major: 2, minor: 0, patch: 0, pre: null });
    expect(bumpVersion(null, "minor")).toEqual({ major: 0, minor: 1, patch: 0, pre: null });
  });
});

describe("release-please files", () => {
  it("reads the root rules, packages['.'] overriding the top level", () => {
    const cfg = parseReleasePleaseConfig(
      JSON.stringify({
        "bump-minor-pre-major": true,
        packages: { ".": { "bump-patch-for-minor-pre-major": true }, "apps/web": {} },
      }),
    );
    expect(cfg?.rules).toEqual({ bumpMinorPreMajor: true, bumpPatchForMinorPreMajor: true });
    expect(cfg?.packages).toEqual([".", "apps/web"]);
  });

  it("refuses text that is not a JSON object", () => {
    expect(parseReleasePleaseConfig("{ nope")).toBeNull();
    expect(parseReleasePleaseConfig("[]")).toBeNull();
  });

  it("reads the manifest's string versions only", () => {
    expect(parseManifest('{".": "0.1.1", "apps/web": "1.0.0", "bad": 3}')).toEqual({ ".": "0.1.1", "apps/web": "1.0.0" });
    expect(parseManifest("oops")).toEqual({});
  });
});

describe("version files", () => {
  it("reads JSON and Cargo versions", () => {
    expect(versionFromJson('{"name":"x","version":"0.2.0"}')).toBe("0.2.0");
    expect(versionFromJson("{}")).toBeNull();
    const toml = '[package]\nname = "assay"\nversion = "0.2.0"\n\n[dependencies]\nversion = "9.9.9"\n';
    expect(versionFromCargoToml(toml)).toBe("0.2.0");
    expect(versionFromCargoToml('[workspace.package]\nversion = "1.0.0"')).toBe("1.0.0");
    expect(versionFromCargoToml('[dependencies]\nversion = "1.0.0"')).toBeNull();
  });

  it("lists the files that disagree with the tag", () => {
    const files = [
      { file: "package.json", version: "0.2.0" },
      { file: "Cargo.toml", version: "0.2.1" },
    ];
    expect(versionMismatches(files, "v0.2.1")).toEqual([{ file: "package.json", version: "0.2.0" }]);
  });
});

describe("tag guards and links", () => {
  const ok = { repo: true, clean: true, hasUpstream: true, ahead: 0 };

  it("says why a tag cannot be made yet", () => {
    expect(tagBlocker(ok)).toBeNull();
    expect(tagBlocker({ ...ok, clean: false })).toMatch(/uncommitted/);
    expect(tagBlocker({ ...ok, hasUpstream: false })).toMatch(/never pushed/);
    expect(tagBlocker({ ...ok, ahead: 2 })).toMatch(/not pushed/);
    expect(tagBlocker({ ...ok, repo: false })).toMatch(/not a git repository/);
  });

  it("builds tag pages only for known hosts", () => {
    expect(tagWebUrl("https://github.com/o/r", "v1.0.0")).toBe("https://github.com/o/r/releases/tag/v1.0.0");
    expect(tagWebUrl("https://gitlab.com/o/r", "v1.0.0")).toBe("https://gitlab.com/o/r/-/tags/v1.0.0");
    expect(tagWebUrl("https://git.example.com/o/r", "v1.0.0")).toBeNull();
    expect(tagWebUrl(null, "v1.0.0")).toBeNull();
  });

  it("reads owner/name from a github.com web URL", () => {
    expect(githubRepoFromWebUrl("https://github.com/acme/app")).toBe("acme/app");
    expect(githubRepoFromWebUrl("https://gitlab.com/acme/app")).toBeNull();
    expect(githubRepoFromWebUrl(null)).toBeNull();
  });
});
