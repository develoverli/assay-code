import { describe, expect, it } from "vitest";
import { getAdapter } from "@/lib/adapters";
import type { ProcResult } from "@/lib/exec";
import type { Project, Tool } from "@/types";

/**
 * Adapters read output written by somebody else's tool. That is exactly the code
 * that breaks silently when a tool renames a field, so it is the code with
 * tests: one fixture per tool, in the shape that tool actually prints.
 */

const project: Project = {
  id: "p1",
  name: "demo",
  path: "D:/work/demo",
  url: null,
  stack: [],
  tags: [],
  authorized: false,
  created_at: 0,
  updated_at: 0,
};

const result = (stdout: string, code = 0): ProcResult => ({
  code,
  stdout,
  stderr: "",
  combined: stdout,
  killed: false,
});

const gitleaksTool = (history: boolean): Tool => ({
  id: "gitleaks",
  name: "Gitleaks",
  source: "tool",
  kind: "cli",
  scope: "local",
  stack: [],
  cmd: "",
  adapter: "gitleaks",
  config: { groups: history ? ["history"] : [], plugins: [] },
  builtin: true,
  enabled: true,
  notes: null,
  created_at: 0,
  updated_at: 0,
});

describe("eslint adapter", () => {
  it("maps messages, severities and locations", async () => {
    const out = JSON.stringify([
      {
        filePath: "D:/work/demo/src/app.ts",
        messages: [
          { ruleId: "no-unused-vars", severity: 2, message: "'x' is defined but never used.", line: 12 },
          { ruleId: "security/detect-eval-with-expression", severity: 1, message: "eval with expression", line: 4 },
        ],
      },
    ]);
    const { findings, summary } = await getAdapter("eslint")(result(out, 1), { project });
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ severity: "high", file: "src/app.ts", line: 12 });
    // a security rule outranks the warning level the plugin reported
    expect(findings[1].severity).toBe("high");
    expect(summary).toContain("2 problems");
  });

  it("reports its own failure as an outcome, never as a finding", async () => {
    const { findings, summary } = await getAdapter("eslint")(result("Oops something broke", 2), { project });
    expect(findings).toHaveLength(0);
    expect(summary).toContain("exit 2");
    expect(summary).toContain("Oops something broke");
  });

  it("reports a clean run as an outcome, with nothing to triage", async () => {
    const { findings, summary } = await getAdapter("eslint")(result("[]", 0), { project });
    expect(findings).toHaveLength(0);
    expect(summary).toContain("No problems");
  });
});

describe("ruff adapter", () => {
  it("grades by rule prefix", async () => {
    const out = JSON.stringify([
      { code: "S105", message: "Possible hardcoded password", filename: "D:/work/demo/app.py", location: { row: 3 } },
      { code: "E501", message: "Line too long", filename: "D:/work/demo/app.py", location: { row: 9 } },
    ]);
    const { findings } = await getAdapter("ruff")(result(out, 1), { project });
    expect(findings[0]).toMatchObject({ severity: "high", file: "app.py", line: 3 });
    expect(findings[1].severity).toBe("low");
  });
});

describe("gitleaks adapter", () => {
  it("treats every leak as critical and keeps the location, not the secret", async () => {
    const out = JSON.stringify([
      {
        Description: "AWS Access Key",
        File: "D:/work/demo/.env.local",
        StartLine: 2,
        RuleID: "aws-access-token",
        Secret: "REDACTED",
      },
    ]);
    const { findings } = await getAdapter("gitleaks")(result(out, 1), { project });
    expect(findings[0]).toMatchObject({ severity: "critical", file: ".env.local", line: 2 });
    expect(JSON.stringify(findings[0].raw)).not.toContain("REDACTED");
  });

  it("says which half of the repository the clean result covers", async () => {
    const disk = await getAdapter("gitleaks")(result("[]", 0), { project, tool: gitleaksTool(false) });
    expect(disk.findings).toHaveLength(0);
    expect(disk.summary).toContain("Git history was not scanned");

    const history = await getAdapter("gitleaks")(result("[]", 0), { project, tool: gitleaksTool(true) });
    expect(history.findings).toHaveLength(0);
    expect(history.summary).toContain("git history");
  });

  it("reports an empty report with a non-zero exit as a failure, not as clean", async () => {
    const res = await getAdapter("gitleaks")(result("fatal: not a git repository", 2), {
      project,
      tool: gitleaksTool(true),
    });
    expect(res.findings).toHaveLength(0);
    expect(res.summary).toContain("exit 2");
    expect(res.summary).toContain("not a git repository");
  });

  it("keeps the location and the commit, never the secret", async () => {
    const out = JSON.stringify([
      {
        RuleID: "generic-api-key",
        Description: "Generic API Key",
        File: "D:/work/demo/src/config.ts",
        StartLine: 7,
        Commit: "abc1234",
        Author: "someone",
        Date: "2026-01-02T03:04:05Z",
        Secret: "REDACTED",
      },
    ]);
    const { findings, summary } = await getAdapter("gitleaks")(result(out, 1), {
      project,
      tool: gitleaksTool(true),
    });
    expect(summary).toBe("1 secret");
    expect(findings[0]).toMatchObject({ severity: "critical", file: "src/config.ts", line: 7 });
    expect(findings[0].raw).toMatchObject({ commit: "abc1234", date: "2026-01-02T03:04:05Z" });
  });
});

describe("osv-scanner adapter", () => {
  it("turns advisories into findings graded by CVSS", async () => {
    const out = JSON.stringify({
      results: [
        {
          source: { path: "D:/work/demo/package-lock.json" },
          packages: [
            {
              package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
              vulnerabilities: [{ id: "GHSA-xxxx", summary: "Prototype pollution" }],
              groups: [{ ids: ["GHSA-xxxx"], max_severity: "9.8" }],
            },
          ],
        },
      ],
    });
    const { findings } = await getAdapter("osv-scanner")(result(out, 1), { project });
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].message).toContain("lodash@4.17.20");
    expect(findings[0].file).toBe("package-lock.json");
  });
});

describe("semgrep adapter", () => {
  it("promotes security rules and keeps the rule id", async () => {
    const out = JSON.stringify({
      results: [
        {
          check_id: "javascript.lang.security.audit.sqli",
          path: "D:/work/demo/src/db.js",
          start: { line: 41 },
          extra: { message: "SQL built from user input", severity: "WARNING", metadata: { category: "security" } },
        },
      ],
      errors: [],
    });
    const { findings } = await getAdapter("semgrep")(result(out, 1), { project });
    expect(findings[0]).toMatchObject({ severity: "high", file: "src/db.js", line: 41 });
    expect(findings[0].message).toContain("javascript.lang.security.audit.sqli");
  });
});

describe("an empty scan is an outcome, not a finding", () => {
  it("never invents a row for a tool that found nothing", async () => {
    const empty = [
      ["eslint", "[]"],
      ["ruff", "[]"],
      ["osv-scanner", JSON.stringify({ results: [] })],
      ["semgrep", JSON.stringify({ results: [], errors: [], paths: { scanned: ["a.ts"], skipped: [] } })],
    ] as const;
    for (const [name, out] of empty) {
      const { findings, summary } = await getAdapter(name)(result(out, 0), { project });
      expect(findings, `${name} invented a finding`).toHaveLength(0);
      expect(summary, `${name} said nothing`).toBeTruthy();
    }
  });
});
