import { describe, expect, it } from "vitest";
import {
  fileCandidates,
  fileTarget,
  fileUrlToPath,
  isLocalUrl,
  resolvePath,
  sliceAround,
  spaceSplits,
  splitLocation,
  targetId,
  urlTarget,
} from "../link-detect";

const texts = (line: string): string[] => fileCandidates(line).map((h) => h.text);

describe("fileCandidates", () => {
  it("keeps two paths on one line apart", () => {
    expect(texts("Edited src/a.ts and src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("keeps line and column, drops the punctuation an agent leaves behind", () => {
    expect(texts("see src/lib/db.ts:485:12.")).toEqual(["src/lib/db.ts:485:12"]);
    expect(texts("(./x.py:3)")).toEqual(["./x.py:3"]);
  });

  it("offers bare names, and not versions or domains", () => {
    expect(texts("Updated README.md and package.json:12")).toEqual(["README.md", "package.json:12"]);
    expect(texts("bumped to 1.2.3")).toEqual([]);
    expect(texts("visit www.example.com")).toEqual([]);
  });

  it("does not read a path out of a URL", () => {
    expect(texts("open https://github.com/acme/app/blob/main/src/a.ts now")).toEqual([]);
  });

  it("reads a POSIX absolute path whole, never from the middle of a relative one", () => {
    expect(texts("wrote /home/me/app/main.rs")).toEqual(["/home/me/app/main.rs"]);
    expect(texts("wrote src/lib/db.ts")).toEqual(["src/lib/db.ts"]);
  });

  it("reads a Windows path with spaces, and offers its pieces as well", () => {
    const [hit] = fileCandidates("D:\\My Work\\app\\main.ts");
    expect(hit.text).toBe("D:\\My Work\\app\\main.ts");
    expect(texts("D:\\work\\a.ts and D:\\work\\b.ts")).toEqual(["D:\\work\\a.ts", "D:\\work\\b.ts"]);
    const glued = fileCandidates("D:\\work\\a.ts and then notes.md")[0];
    expect(glued.text).toBe("D:\\work\\a.ts and then notes.md");
    expect(spaceSplits(glued).map((h) => h.text)).toEqual(["D:\\work\\a.ts"]);
  });

  it("reports where each hit starts", () => {
    const [a, b] = fileCandidates("x src/a.ts y lib/b.rs");
    expect(a.start).toBe(2);
    expect(b.start).toBe(13);
  });
});

describe("splitLocation", () => {
  it("splits line and column without eating the drive letter", () => {
    expect(splitLocation("D:/a/b.ts:12:4")).toEqual({ path: "D:/a/b.ts", line: 12 });
    expect(splitLocation("D:/a/b.ts")).toEqual({ path: "D:/a/b.ts", line: 0 });
    expect(splitLocation("src/b.ts:7")).toEqual({ path: "src/b.ts", line: 7 });
  });
});

describe("resolvePath", () => {
  it("joins relative paths onto the session folder, slash-separated", () => {
    expect(resolvePath("D:\\work\\app\\", ".\\src\\a.ts")).toBe("D:/work/app/src/a.ts");
    expect(resolvePath("/repo", "/etc/hosts.txt")).toBe("/etc/hosts.txt");
    expect(resolvePath("/repo", "~/notes.md", "/home/me")).toBe("/home/me/notes.md");
  });
});

describe("fileUrlToPath", () => {
  it("turns an OSC 8 file link into a path and a line", () => {
    expect(fileUrlToPath("file:///D:/work/app/src/a.ts")).toEqual({ path: "D:/work/app/src/a.ts", line: 0 });
    expect(fileUrlToPath("file:///home/me/a%20b.ts#L42")).toEqual({ path: "/home/me/a b.ts", line: 42 });
    expect(fileUrlToPath("file:///repo/a.ts:9")).toEqual({ path: "/repo/a.ts", line: 9 });
  });

  it("refuses another machine's share and anything that is not a file URL", () => {
    expect(fileUrlToPath("file://server/share/a.ts")).toBeNull();
    expect(fileUrlToPath("https://example.com/a.ts")).toBeNull();
    expect(fileUrlToPath("not a url")).toBeNull();
  });
});

describe("targets", () => {
  it("tells images from code by extension", () => {
    expect(fileTarget("D:/a/shot.PNG", 0).kind).toBe("image");
    expect(fileTarget("D:/a/demo.mp4", 0).kind).toBe("video");
    expect(fileTarget("D:/a/clip.WEBM", 0).kind).toBe("video");
    expect(fileTarget("D:/a/voice.mp3", 0).kind).toBe("audio");
    expect(fileTarget("D:/a/notes.md", 0).kind).toBe("code");
    expect(fileTarget("D:/a/main.ts", 3)).toEqual({ kind: "code", path: "D:/a/main.ts", name: "main.ts", line: 3 });
  });

  it("knows a dev server from the internet", () => {
    expect(isLocalUrl("http://localhost:5173/")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:8000")).toBe(true);
    expect(isLocalUrl("http://app.localhost:3000")).toBe(true);
    expect(isLocalUrl("https://example.com")).toBe(false);
    expect(urlTarget("https://example.com")).toEqual({ kind: "url", url: "https://example.com", local: false });
    expect(targetId(urlTarget("http://localhost:3000"))).toBe("http://localhost:3000");
  });
});

describe("sliceAround", () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");

  it("centres a window on the line, with the line marked", () => {
    const s = sliceAround(text, 20, 15);
    expect(s.first).toBe(15);
    expect(s.lines[s.mark ?? -1]).toBe("line 20");
    expect(s.lines).toHaveLength(15);
  });

  it("starts at the top when there is no line, and clamps past the end", () => {
    expect(sliceAround(text, 0, 5)).toEqual({ lines: ["line 1", "line 2", "line 3", "line 4", "line 5"], first: 1, mark: null });
    const end = sliceAround(text, 99, 5);
    expect(end.lines[end.mark ?? -1]).toBe("line 40");
  });
});
