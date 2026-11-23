import { describe, expect, it } from "vitest";
import { pullRequestUrl, supportsPullRequest } from "../pr-url";

describe("pullRequestUrl", () => {
  it("opens GitHub's compare form", () => {
    expect(pullRequestUrl("https://github.com/acme/app", "feat/login")).toBe(
      "https://github.com/acme/app/compare/feat%2Flogin?expand=1",
    );
  });

  it("opens a GitLab merge request, on gitlab.com and self-hosted", () => {
    expect(pullRequestUrl("https://gitlab.com/acme/app", "fix #1")).toBe(
      "https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix%20%231",
    );
    expect(pullRequestUrl("https://gitlab.acme.dev/team/app", "dev")).toBe(
      "https://gitlab.acme.dev/team/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=dev",
    );
  });

  it("opens a Bitbucket pull request", () => {
    expect(pullRequestUrl("https://bitbucket.org/acme/app", "a&b")).toBe(
      "https://bitbucket.org/acme/app/pull-requests/new?source=a%26b",
    );
  });

  it("ignores a trailing slash on the remote", () => {
    expect(pullRequestUrl("https://github.com/acme/app/", "main")).toBe("https://github.com/acme/app/compare/main?expand=1");
  });

  it("answers null for a host it does not know, or a remote that is not a URL", () => {
    expect(pullRequestUrl("https://git.example.com/acme/app", "main")).toBeNull();
    expect(pullRequestUrl("not a url", "main")).toBeNull();
    expect(supportsPullRequest("https://git.example.com/acme/app")).toBe(false);
    expect(supportsPullRequest(null)).toBe(false);
    expect(supportsPullRequest("https://github.com/acme/app")).toBe(true);
  });
});
