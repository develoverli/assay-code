import { describe, expect, it, vi } from "vitest";
import { isAuthRefusal } from "@/lib/git";
import { sleep } from "@/lib/github";
import { ENGINES, patternFileBody } from "@/lib/code-search";
import { isSafeSessionId } from "@/store/bench";
import { selectRunMetas, type LiveRun } from "@/store/app";

describe("isAuthRefusal", () => {
  it("renews on a 401 or a refused login", () => {
    expect(isAuthRefusal("fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 401")).toBe(true);
    expect(isAuthRefusal("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/a/b.git/'")).toBe(true);
  });

  it("does not renew on a 403: no renewal grants push rights", () => {
    expect(
      isAuthRefusal(
        "remote: Permission to a/b.git denied to someone.\nfatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403",
      ),
    ).toBe(false);
    expect(isAuthRefusal("error: 4010 bytes")).toBe(false);
  });
});

describe("sleep", () => {
  it("removes its abort listener when the timer wins", async () => {
    vi.useFakeTimers();
    try {
      const ctrl = new AbortController();
      const add = vi.spyOn(ctrl.signal, "addEventListener");
      const remove = vi.spyOn(ctrl.signal, "removeEventListener");
      const done = sleep(1000, ctrl.signal);
      vi.advanceTimersByTime(1000);
      await done;
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when aborted, before or during the wait", async () => {
    const before = new AbortController();
    before.abort();
    await expect(sleep(10_000, before.signal)).rejects.toThrow();
    const during = new AbortController();
    const waiting = sleep(10_000, during.signal);
    during.abort();
    await expect(waiting).rejects.toThrow();
  });
});

describe("code search argv", () => {
  const hostile = `%PATH% & del x "quoted" $HOME \`id\``;

  it("never puts the query on a shell command line", () => {
    for (const engine of ENGINES) {
      const call = engine.args(hostile, "C:/Temp/assay-search-1.txt");
      if (call.kind === "program") {
        // straight argv to git: the query is one untouched argument
        expect(call.program).toBe("git");
        expect(call.args.at(-1)).toBe(hostile);
      } else {
        expect(call.tokens.join(" ")).not.toContain(hostile);
        expect(call.tokens).toContain("-f");
        expect(call.tokens).toContain("C:/Temp/assay-search-1.txt");
      }
    }
  });

  it("writes one pattern, never an empty line", () => {
    expect(patternFileBody("foo\r\nbar\n")).toBe("foo bar");
    expect(patternFileBody(hostile)).toBe(hostile);
  });
});

describe("isSafeSessionId", () => {
  it("takes a Claude session UUID", () => {
    expect(isSafeSessionId("3f2b8c1e-9a4d-4e7b-8f21-0c6d5a9e1b77")).toBe(true);
  });

  it("refuses anything a shell would read as more than an id", () => {
    for (const bad of ["", "-rf", "abc; rm -rf ~", "a b", "$(id)", "x&calc", "id\n"]) {
      expect(isSafeSessionId(bad)).toBe(false);
    }
  });
});

describe("selectRunMetas", () => {
  const run = (log: string, status: LiveRun["status"] = "running"): LiveRun => ({
    runId: "r1",
    projectId: "p1",
    projectName: "P",
    label: "eslint",
    cmd: "eslint .",
    status,
    log,
    startedAt: 1,
  });

  it("returns the same array while only the log grows", () => {
    const a = selectRunMetas({ runs: [run("one")] });
    const b = selectRunMetas({ runs: [run("one two")] });
    expect(b).toBe(a);
    expect(a[0]).not.toHaveProperty("log");
  });

  it("returns a new array when the status changes", () => {
    const a = selectRunMetas({ runs: [run("x")] });
    const b = selectRunMetas({ runs: [run("x", "done")] });
    expect(b).not.toBe(a);
    expect(b[0].status).toBe("done");
  });
});
