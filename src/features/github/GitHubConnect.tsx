import { Copy, ExternalLink, LogOut, TriangleAlert, XCircle } from "lucide-react";
import * as React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GITHUB_CLIENT_ID, startDeviceFlow, waitForToken, type DeviceCode } from "@/lib/github";
import { writeClipboard } from "@/lib/clipboard";
import { useGitHub } from "@/store/github";
import { Badge, Button, Spinner } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";
import { GitHubMark } from "./GitHubMark";

type Step =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "code"; code: DeviceCode }
  | { kind: "error"; message: string };

/**
 * The OAuth device flow as one row: request a code, show it, wait for approval.
 * Once connected, shows the account and offers Disconnect. Shared by the
 * settings card and the clone dialog.
 */
export function GitHubConnect() {
  const t = useT();
  const { account, loaded, load, setAccount, disconnect, rejected, rejectedDetail } = useGitHub();
  const [step, setStep] = React.useState<Step>({ kind: "idle" });
  const [copied, setCopied] = React.useState(false);
  const abort = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // leaving the screen mid-flow stops the polling; the code stays valid on
  // GitHub's side but nothing here is waiting for it any more
  React.useEffect(() => () => abort.current?.abort(), []);

  const connect = async () => {
    setStep({ kind: "starting" });
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const code = await startDeviceFlow();
      setStep({ kind: "code", code });
      const a = await waitForToken(code, ctl.signal);
      setAccount(a);
      setStep({ kind: "idle" });
    } catch (e) {
      if (ctl.signal.aborted) setStep({ kind: "idle" });
      else setStep({ kind: "error", message: (e as Error).message });
    } finally {
      if (abort.current === ctl) abort.current = null;
    }
  };

  const cancel = () => {
    abort.current?.abort();
    setStep({ kind: "idle" });
  };

  const copyCode = async (code: string) => {
    await writeClipboard(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-text-3">
        <Spinner className="h-3.5 w-3.5" /> {t("Reading the linked account…")}
      </div>
    );
  }

  if (account) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        {account.avatarUrl ? (
          <img src={account.avatarUrl} alt="" width={28} height={28} className="h-7 w-7 rounded-full bg-surface-2" />
        ) : (
          <GitHubMark className="h-7 w-7 text-text-2" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium">{account.login}</span>
            <Badge tone="success">{t("connected")}</Badge>
          </div>
          <p className="text-[11px] text-text-3">
            {t("Assay lists and clones the repositories this account sees, and pushes or pulls only when you click Push or Pull in Workspace.")}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void disconnect()} title={t("Forget the token on this machine")}>
          <LogOut className="h-3.5 w-3.5" /> {t("Disconnect")}
        </Button>
      </div>
    );
  }

  if (step.kind === "code") {
    const { code } = step;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-text-2">{t("Enter this code on GitHub, then come back. Assay is waiting.")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <output
            aria-label={t("Device code")}
            className="selectable rounded-md border border-border bg-surface-2 px-3 py-1.5 font-mono text-[15px] font-semibold tracking-[0.2em] text-text"
          >
            {code.userCode}
          </output>
          <Button variant="secondary" size="sm" onClick={() => void copyCode(code.userCode)}>
            <Copy className="h-3.5 w-3.5" /> {copied ? t("Copied") : t("Copy")}
          </Button>
          <Button variant="primary" size="sm" onClick={() => void openUrl(code.verificationUri)}>
            <ExternalLink className="h-3.5 w-3.5" /> {t("Open GitHub")}
          </Button>
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-text-3">
            <Spinner className="h-3.5 w-3.5" /> {t("waiting for approval")}
          </span>
          <Button variant="ghost" size="sm" onClick={cancel}>
            {t("Cancel")}
          </Button>
        </div>
        <p className="font-mono text-[11px] text-text-3 selectable">{code.verificationUri}</p>
      </div>
    );
  }

  const noClient = !GITHUB_CLIENT_ID;
  return (
    <div className="flex flex-col gap-2">
      {rejected && (
        <p role="alert" className="flex items-start gap-1.5 text-[12px] text-warn">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t("GitHub no longer accepts the saved token. Reconnect to keep cloning.")}
            {/* GitHub's own words, so the reason is read rather than guessed */}
            {rejectedDetail && (
              <span className="mt-0.5 block font-mono text-[11px] text-text-3 selectable">{rejectedDetail}</span>
            )}
          </span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[11px] text-text-3">
          {t("Link an account to browse your repositories and clone one straight into a project. GitHub shows you a code; Assay never sees your password.")}
        </p>
        <Button
          variant="primary"
          size="sm"
          loading={step.kind === "starting"}
          disabled={noClient}
          title={noClient ? t("This build has no GitHub OAuth client id, so it cannot ask for a code.") : undefined}
          onClick={() => void connect()}
        >
          <GitHubMark className="h-3.5 w-3.5" /> {rejected ? t("Reconnect GitHub") : t("Connect GitHub")}
        </Button>
      </div>
      <p className="text-[11px] text-text-3">
        {t("Each connection creates a new token, and GitHub keeps at most 10 per app: connect once and leave it.")}
      </p>
      {noClient && (
        <p className="text-[11px] text-warn">{t("This build has no GitHub OAuth client id, so it cannot ask for a code.")}</p>
      )}
      {step.kind === "error" && (
        <p role="alert" className="flex items-start gap-1.5 text-[11px] text-danger">
          <XCircle className="mt-px h-3.5 w-3.5 shrink-0" /> {step.message}
        </p>
      )}
    </div>
  );
}
