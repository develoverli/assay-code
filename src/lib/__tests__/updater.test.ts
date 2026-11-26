import { describe, expect, it } from "vitest";
import { canSelfUpdate, formatBytes, percent, releaseTime, releaseUrl, shouldOffer } from "@/lib/updater";

describe("updater", () => {
  it("a skipped version is not offered again", () => {
    expect(shouldOffer("0.2.0", "0.2.0")).toBe(false);
  });

  it("a newer version than the skipped one is offered", () => {
    expect(shouldOffer("0.3.0", "0.2.0")).toBe(true);
  });

  it("only a .deb or .rpm cannot replace itself", () => {
    expect([canSelfUpdate("bundle"), canSelfUpdate("appimage"), canSelfUpdate("package")]).toEqual([true, true, false]);
  });

  it("links to the release tag whether or not the version carries a v", () => {
    expect([releaseUrl("0.2.0"), releaseUrl("v0.2.0")]).toEqual([
      "https://github.com/develoverli/assay-code/releases/tag/v0.2.0",
      "https://github.com/develoverli/assay-code/releases/tag/v0.2.0",
    ]);
  });

  it("reads the date the plugin returns in the time crate's format", () => {
    expect(releaseTime("2026-11-20 10:00:00.0 +00:00:00")).toBe(Date.parse("2026-11-20T00:00:00Z"));
  });

  it("reads an RFC 3339 date as it is", () => {
    expect(releaseTime("2026-11-20T10:30:00Z")).toBe(Date.parse("2026-11-20T10:30:00Z"));
  });

  it("gives no date for a missing or unreadable one", () => {
    expect([releaseTime(null), releaseTime("soon")]).toEqual([null, null]);
  });

  it("has no percentage until the size is known", () => {
    expect(percent(500, null)).toBeNull();
  });

  it("caps the percentage at 100", () => {
    expect(percent(150, 100)).toBe(100);
  });

  it("formats sizes the way the dialog shows them", () => {
    expect([formatBytes(512), formatBytes(2048), formatBytes(13_002_342)]).toEqual(["512 B", "2 KB", "12.4 MB"]);
  });
});
