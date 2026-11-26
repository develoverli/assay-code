import { describe, expect, it } from "vitest";
import { knownBinPaths } from "@/lib/agent-bins";
import { linkHost, parsePort, portRows, silentTunnels, type ListeningPort, type Tunnel } from "@/lib/ports";
import { installRecipe, type Managers } from "@/lib/toolchain";

const sock = (port: number, projectId: string | null, extra: Partial<ListeningPort> = {}): ListeningPort => ({
  port,
  host: "127.0.0.1",
  pid: 100 + port,
  process: "node",
  projectId,
  via: projectId ? "process" : null,
  ...extra,
});

const tun = (id: string, port: number, projectId: string, extra: Partial<Tunnel> = {}): Tunnel => ({
  id,
  port,
  projectId,
  url: `https://${id}.trycloudflare.com`,
  startedAt: 0,
  phase: "ready",
  error: null,
  ...extra,
});

describe("portRows", () => {
  it("lists only the ports the project's terminals serve", () => {
    const rows = portRows("p1", [sock(5173, "p1"), sock(5432, null), sock(3000, "p2")], [], []);
    expect(rows.map((r) => r.port)).toEqual([5173]);
  });

  it("keeps a hand-added port listed while nothing listens on it", () => {
    const rows = portRows("p1", [], [8080], []);
    expect(rows).toEqual([{ port: 8080, listening: null, manual: true, tunnel: null }]);
  });

  it("gives a hand-added port the socket another process holds", () => {
    const rows = portRows("p1", [sock(8080, null, { process: "com.docker.backend" })], [8080], []);
    expect(rows[0].listening?.process).toBe("com.docker.backend");
  });

  it("shows a link on its port, and never one from another project", () => {
    const rows = portRows("p1", [sock(5173, "p1")], [], [tun("a", 5173, "p1"), tun("b", 5173, "p2")]);
    expect(rows[0].tunnel?.id).toBe("a");
  });

  it("orders rows by port, one row per port", () => {
    const rows = portRows("p1", [sock(5173, "p1"), sock(3000, "p1")], [3000, 9000], []);
    expect(rows.map((r) => r.port)).toEqual([3000, 5173, 9000]);
  });
});

describe("silentTunnels", () => {
  it("waits one poll before closing a link whose port went quiet", () => {
    const first = silentTunnels([tun("a", 5173, "p1")], [], new Map());
    expect(first.close).toEqual([]);
    const second = silentTunnels([tun("a", 5173, "p1")], [], first.misses);
    expect(second.close).toEqual(["a"]);
  });

  it("forgets the misses once the port answers again", () => {
    const first = silentTunnels([tun("a", 5173, "p1")], [], new Map());
    const back = silentTunnels([tun("a", 5173, "p1")], [sock(5173, "p1")], first.misses);
    expect(back.misses.size).toBe(0);
  });

  it("leaves a failed tunnel for the user to read", () => {
    const verdict = silentTunnels([tun("a", 5173, "p1", { phase: "failed" })], [], new Map([["a", 5]]));
    expect(verdict.close).toEqual([]);
  });
});

describe("parsePort", () => {
  it("accepts a number with or without a leading colon", () => {
    expect([parsePort("8080"), parsePort(" :3000 ")]).toEqual([8080, 3000]);
  });

  it("refuses what cannot be a port", () => {
    expect(["0", "65536", "80a", "", "1.5", "-1"].map(parsePort)).toEqual([null, null, null, null, null, null]);
  });
});

describe("linkHost", () => {
  it("keeps only the host of a link", () => {
    expect(linkHost("https://calm-river.trycloudflare.com/")).toBe("calm-river.trycloudflare.com");
  });
});

describe("cloudflared on the machine", () => {
  const all: Managers = { npm: true, winget: true, brew: true, uv: true, pipx: true };

  it("installs with winget on Windows", () => {
    expect(installRecipe("cloudflared", "windows", all)).toEqual({
      kind: "command",
      tokens: [
        "winget",
        "install",
        "-e",
        "--id",
        "Cloudflare.cloudflared",
        "--accept-source-agreements",
        "--accept-package-agreements",
      ],
    });
  });

  it("installs with brew on macOS", () => {
    expect(installRecipe("cloudflared", "macos", all)).toEqual({ kind: "command", tokens: ["brew", "install", "cloudflared"] });
  });

  it("points Linux at the download page", () => {
    expect(installRecipe("cloudflared", "linux", all).kind).toBe("manual");
  });

  it("finds winget's install outside PATH", () => {
    const dirs = { home: "C:/Users/me", localData: "C:/Users/me/AppData/Local", roaming: "C:/Users/me/AppData/Roaming" };
    expect(knownBinPaths("cloudflared", true, dirs)).toContain("C:/Program Files (x86)/cloudflared/cloudflared.exe");
  });
});
