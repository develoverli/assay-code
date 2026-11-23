/**
 * Where a host opens the form for a new pull (or merge) request from a branch. Pure, so it is
 * tested: `remote` is the web URL `git.webUrlFromRemote` already cleaned of credentials.
 * A host whose form Assay does not know answers null, and no button pretends otherwise.
 */
export function pullRequestUrl(remote: string, branch: string): string | null {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }
  const base = remote.replace(/\/+$/, "");
  const host = url.hostname.toLowerCase();
  const ref = encodeURIComponent(branch);
  if (host === "github.com") return `${base}/compare/${ref}?expand=1`;
  if (host === "gitlab.com" || host.includes("gitlab"))
    return `${base}/-/merge_requests/new?${encodeURIComponent("merge_request[source_branch]")}=${ref}`;
  if (host === "bitbucket.org") return `${base}/pull-requests/new?source=${ref}`;
  return null;
}

/** Whether `pullRequestUrl` knows the form for this remote — what decides if the button is offered. */
export function supportsPullRequest(remote: string | null): boolean {
  return remote !== null && pullRequestUrl(remote, "main") !== null;
}
