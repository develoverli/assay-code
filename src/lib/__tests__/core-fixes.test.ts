import { describe, expect, it } from "vitest";
import { parseDiff, unquoteGitPath } from "@/lib/runner";
import { appleScriptString, shQuote, unixKillTreeScript, unixTerminalScript } from "@/lib/exec";
import { expectedChecksum, parseChecksums } from "@/lib/sandbox";
import { mdCell, toMarkdown } from "@/lib/export";
import { uniformIndex } from "@/lib/sonar";
import { uid } from "@/lib/utils";
import type { Finding, Project } from "@/types";

describe("parseDiff", () => {
  it("keeps a path with spaces whole, without git's trailing tab", () => {
    const diff = [
      "diff --git a/src/my file.ts b/src/my file.ts",
      "index 1..2 100644",
      "--- a/src/my file.ts\t",
      "+++ b/src/my file.ts\t",
      "@@ -1 +1,2 @@",
      " a",
      "+b",
      "",
    ].join("\n");
    const [e] = parseDiff(diff);
    expect(e.file).toBe("src/my file.ts");
    expect(e.added).toBe(1);
    expect(e.removed).toBe(0);
  });

  it("decodes C-quoted paths (octal UTF-8 and escapes)", () => {
    const diff = [
      'diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/caf\\303\\251 \\"x\\".txt"\t',
      "@@ -0,0 +1 @@",
      "+hi",
      "",
    ].join("\n");
    expect(parseDiff(diff)[0].file).toBe('café "x".txt');
  });

  it("names a deleted file from its --- line", () => {
    const diff = [
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
      "",
    ].join("\n");
    const [e] = parseDiff(diff);
    expect(e.file).toBe("old.txt");
    expect(e.removed).toBe(2);
  });

  it("names a binary file (no ---/+++ lines) from the header, and splits several files", () => {
    const diff = [
      "diff --git a/img dir/new.bin b/img dir/new.bin",
      "new file mode 100644",
      "index 0000000..88768ef",
      "GIT binary patch",
      "literal 5",
      "McmZQzOv=my00M6TI{*Lx",
      "",
      "literal 0",
      "HcmV?d00001",
      "",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    const out = parseDiff(diff);
    expect(out.map((e) => e.file)).toEqual(["img dir/new.bin", "b.ts"]);
    expect(out[0].diff.endsWith("HcmV?d00001\n\n")).toBe(true);
  });

  it("uses the rename target for a pure rename", () => {
    const diff = [
      "diff --git a/one two.ts b/three.ts",
      "similarity index 100%",
      "rename from one two.ts",
      "rename to three.ts",
      "",
    ].join("\n");
    expect(parseDiff(diff)[0].file).toBe("three.ts");
  });

  it("counts an added line that starts with ++ inside a hunk", () => {
    const diff = ["diff --git a/a.c b/a.c", "--- a/a.c", "+++ b/a.c", "@@ -1 +1,2 @@", " i", "+++i;", ""].join("\n");
    expect(parseDiff(diff)[0].added).toBe(1);
  });

  it("leaves unquoted paths alone", () => {
    expect(unquoteGitPath("a/plain.ts")).toBe("a/plain.ts");
    expect(unquoteGitPath('"a/tab\\there"')).toBe("a/tab\there");
  });
});

describe("terminal quoting", () => {
  it("POSIX-quotes a single quote", () => {
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });

  it("escapes backslashes and double quotes for AppleScript", () => {
    expect(appleScriptString('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
  });

  it("builds an osascript line where the command cannot close the quotes", () => {
    const line = unixTerminalScript("macos", `echo "a" 'b'`);
    expect(line).toBe(`osascript -e 'tell app "Terminal" to do script "echo \\"a\\" '\\''b'\\''"'`);
  });

  it("wraps the Linux command for sh -c in one quoted word", () => {
    expect(unixTerminalScript("linux", "echo 'x'")).toBe(
      "x-terminal-emulator -e sh -c 'echo '\\''x'\\''; exec bash' || xterm -e sh -c 'echo '\\''x'\\''; exec bash'",
    );
  });

  it("kills the tree by walking descendants rather than a process group", () => {
    const script = unixKillTreeScript(4242);
    expect(script).toContain("t 4242");
    expect(script).not.toContain("-4242");
  });
});

describe("release checksums", () => {
  const sums = [
    "b8420d5485ba792626315f1bf9a5a2046e971d38eea75bf9090c38852dbc3b1b  osv-scanner_darwin_amd64",
    "FB7DAB19A8BD9BBE5C3189F09D4B7EE1820C9553A23BAC202648A56EFD2F6EE8  osv-scanner_linux_amd64",
    "",
  ].join("\r\n");

  it("parses sha256sum lines into name -> lowercase hash", () => {
    const m = parseChecksums(sums);
    expect(m.size).toBe(2);
    expect(m.get("osv-scanner_linux_amd64")).toBe("fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8");
  });

  it("finds the asset by name and refuses one that is not listed", () => {
    expect(expectedChecksum(sums, "osv-scanner_darwin_amd64")).toBe(
      "b8420d5485ba792626315f1bf9a5a2046e971d38eea75bf9090c38852dbc3b1b",
    );
    expect(expectedChecksum(sums, "osv-scanner_windows_amd64.exe")).toBeNull();
  });

  it("reads cargo-dist's `<hash> *<asset>` single-file form and a bare hash", () => {
    const h = "00c5d5793d308e8575b16b73035271" + "10dd49bd02d46db0a8668b0eefdca14c2e";
    expect(expectedChecksum(`${h} *ruff-x86_64-pc-windows-msvc.zip\n`, "ruff-x86_64-pc-windows-msvc.zip")).toBe(h);
    expect(expectedChecksum(`${h}\n`, "anything.zip")).toBe(h);
    expect(expectedChecksum("not a checksum\n", "anything.zip")).toBeNull();
  });
});

describe("markdown export", () => {
  it("keeps a multi-line message inside its table cell", () => {
    expect(mdCell("a | b\r\nc\nd")).toBe("a \\| b<br>c<br>d");
  });

  it("writes one table row per open finding", () => {
    const project = { id: "p", name: "demo", path: null } as unknown as Project;
    const finding = {
      id: "f",
      severity: "high",
      status: "open",
      message: "first line\nsecond line",
      file: "src/a.ts",
      line: 3,
      tool_id: "eslint",
    } as unknown as Finding;
    const md = toMarkdown(project, [finding], () => "ESLint");
    const rows = md.split("\n").filter((l) => l.startsWith("| high"));
    expect(rows).toEqual(["| high | first line<br>second line | `src/a.ts:3` | ESLint |"]);
  });
});

describe("uniformIndex", () => {
  it("rejects bytes past the last full multiple instead of folding them", () => {
    // n = 10: 250..255 would bias 0..5, so they are skipped
    const bytes = [255, 250, 7];
    expect(uniformIndex(10, () => bytes.shift() ?? 0)).toBe(7);
    expect(uniformIndex(10, () => 249)).toBe(9);
  });
});

describe("uid", () => {
  it("is the prefix plus 16 hex chars, no dash", () => {
    const id = uid("run_");
    expect(id).toMatch(/^run_[0-9a-f]{16}$/);
    expect(uid()).not.toBe(uid());
  });
});
