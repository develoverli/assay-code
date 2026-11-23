import { CheckCircle2, FolderOpen, KeyRound, PlugZap, ShieldAlert, ShieldQuestion } from "lucide-react";
import * as React from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button, Field, Input, SwitchField, Textarea } from "@/components/ui/primitives";
import {
  DEFAULT_EXCLUDES,
  defaultPort,
  deleteServerSecret,
  hasServerSecret,
  parseExcludes,
  PROTOCOL_LABEL,
  setServerSecret,
  testServer,
  type TestResult,
} from "@/lib/deploy";
import { useT } from "@/lib/i18n";
import { cn, now, uid } from "@/lib/utils";
import { useDeploy } from "@/store/deploy";
import type { DeployAuth, DeployProtocol, DeployServer } from "@/types";

/** Keychain account suffix for a secret typed into the dialog and only being tested. */
const TEST_SECRET_SUFFIX = ":test";

/**
 * Add or edit a server. Test connection proves the login, lists the remote
 * folder, and on first contact asks the user to trust the SSH host key.
 */

function blankServer(projectId: string, first: boolean): DeployServer {
  return {
    id: uid("srv_"),
    project_id: projectId,
    name: "",
    protocol: "sftp",
    host: "",
    port: 22,
    username: "",
    auth: "password",
    key_path: null,
    remote_path: "",
    local_dir: "",
    excludes: [...DEFAULT_EXCLUDES],
    host_key: null,
    is_default: first,
    auto_upload: false,
    last_deploy_at: null,
    created_at: now(),
  };
}

/** A row of mutually exclusive choices, as a radio group a keyboard can walk. */
function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-border bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-6 cursor-pointer rounded px-2.5 text-xs font-medium transition-colors",
            "focus-visible:outline-2 focus-visible:outline-accent",
            value === o.value ? "bg-accent-soft text-accent" : "text-text-2 hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** What Test connection found, in the words the user needs to decide. */
function TestOutcome({
  result,
  error,
  host,
  onTrust,
}: {
  result: TestResult | null;
  error: string | null;
  host: string;
  onTrust: (fingerprint: string) => void;
}) {
  const t = useT();
  if (error) {
    return (
      <p className="selectable rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
        {error}
      </p>
    );
  }
  if (!result) return null;
  if (result.status === "unknown-host") {
    return (
      <div className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2.5 text-[12px] text-text-2">
        <p className="flex items-center gap-1.5 font-medium text-warn">
          <ShieldQuestion className="h-3.5 w-3.5" /> {t("First connection to {host}", { host })}
        </p>
        <p className="mt-1">
          {t("Before trusting it, check that this is the server's key (your host shows it in its panel, or run ssh-keyscan on the server):")}
        </p>
        <p className="selectable mt-1.5 break-all font-mono text-[11px] text-text">{result.fingerprint}</p>
        <Button variant="secondary" size="sm" className="mt-2" onClick={() => onTrust(result.fingerprint)}>
          {t("Trust this key")}
        </Button>
      </div>
    );
  }
  if (result.status === "host-changed") {
    return (
      <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-[12px] text-text-2">
        <p className="flex items-center gap-1.5 font-medium text-danger">
          <ShieldAlert className="h-3.5 w-3.5" /> {t("The server's key changed")}
        </p>
        <p className="mt-1">
          {t("A reinstalled server gets a new key, and so does a connection someone is intercepting. Nothing was sent. Trust the new key only if you know why it changed.")}
        </p>
        <p className="selectable mt-1.5 break-all font-mono text-[11px]">
          {t("Accepted")}: {result.expected}
          <br />
          {t("Now")}: <span className="text-text">{result.fingerprint}</span>
        </p>
        <Button variant="danger" size="sm" className="mt-2" onClick={() => onTrust(result.fingerprint)}>
          {t("Trust the new key")}
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2.5 text-[12px] text-text-2">
      <p className="flex items-center gap-1.5 font-medium text-success">
        <CheckCircle2 className="h-3.5 w-3.5" /> {t("Connected")}
      </p>
      <p className="selectable mt-1 font-mono text-[11px] text-text">{result.cwd}</p>
      {result.entries.length > 0 ? (
        <p className="selectable mt-1 line-clamp-3 font-mono text-[11px] text-text-3">{result.entries.join("  ")}</p>
      ) : (
        <p className="mt-1 text-[11px] text-text-3">{t("The folder is empty.")}</p>
      )}
    </div>
  );
}

export function ServerDialog({
  open: isOpen,
  onOpenChange,
  projectId,
  server,
  first,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  /** Edit this one; absent to add a new server. */
  server?: DeployServer | null;
  /** The project has no server yet: the new one is its default. */
  first: boolean;
}) {
  const t = useT();
  const saveServer = useDeploy((s) => s.saveServer);
  const [draft, setDraft] = React.useState<DeployServer>(() => server ?? blankServer(projectId, first));
  const [excludesText, setExcludesText] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [secretSaved, setSecretSaved] = React.useState(false);
  const [replacing, setReplacing] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<TestResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  /** A secret written for a server that was then never saved has to go again. */
  const wroteSecret = React.useRef(false);

  React.useEffect(() => {
    if (!isOpen) return;
    const base = server ?? blankServer(projectId, first);
    setDraft(base);
    setExcludesText(base.excludes.join("\n"));
    setSecret("");
    setReplacing(false);
    setResult(null);
    setError(null);
    wroteSecret.current = false;
    setSecretSaved(false);
    if (server) void hasServerSecret(server.id).then(setSecretSaved).catch(() => setSecretSaved(false));
  }, [isOpen, server, projectId, first]);

  const patch = (p: Partial<DeployServer>) => {
    setDraft((d) => ({ ...d, ...p }));
    // anything that changes where or how it connects makes the last answer stale
    if ("host" in p || "port" in p || "protocol" in p || "username" in p || "auth" in p || "remote_path" in p || "key_path" in p) {
      setResult(null);
      setError(null);
    }
  };

  const setProtocol = (protocol: DeployProtocol) => {
    setDraft((d) => ({
      ...d,
      protocol,
      // a port still on the old default follows the protocol; one the user typed stays
      port: d.port === defaultPort(d.protocol) ? defaultPort(protocol) : d.port,
      auth: protocol === "sftp" ? d.auth : "password",
      // a key is SFTP's; a pinned host key is too
      host_key: protocol === "sftp" ? d.host_key : null,
    }));
    setResult(null);
    setError(null);
  };

  const current = (): DeployServer => ({
    ...draft,
    name: draft.name.trim() || draft.host.trim(),
    host: draft.host.trim(),
    username: draft.username.trim(),
    remote_path: draft.remote_path.trim(),
    local_dir: draft.local_dir.trim().replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, ""),
    key_path: draft.auth === "key" ? draft.key_path?.trim() || null : null,
    excludes: parseExcludes(excludesText),
  });

  /** A typed secret goes to the keychain before anything uses it; the webview never reads it back. */
  const storeSecret = async (id: string) => {
    if (!secret) return;
    await setServerSecret(id, secret);
    wroteSecret.current = !server;
    setSecret("");
    setSecretSaved(true);
    setReplacing(false);
  };

  const invalid = (() => {
    if (!draft.host.trim()) return t("Add the server's host.");
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) return t("The port is a number from 1 to 65535.");
    if (!draft.username.trim()) return t("Add the user to log in as.");
    return null;
  })();

  const runTest = async (hostKey: string | null = draft.host_key) => {
    setTesting(true);
    setError(null);
    setResult(null);
    // deploy_test reads the secret from the keychain by server id. A typed secret is filed under a
    // scratch account just for this test and deleted right after, so the server's real entry only
    // changes on Save — Cancel can never leave a different password behind.
    const scratchId = secret ? `${draft.id}${TEST_SECRET_SUFFIX}` : null;
    try {
      if (scratchId) await setServerSecret(scratchId, secret);
      setResult(await testServer({ ...current(), id: scratchId ?? draft.id, host_key: hostKey }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (scratchId) await deleteServerSecret(scratchId).catch(() => {});
      setTesting(false);
    }
  };

  const trust = (fingerprint: string) => {
    patch({ host_key: fingerprint });
    void runTest(fingerprint);
  };

  const pickKey = async () => {
    const sel = await open({ multiple: false, directory: false });
    if (typeof sel === "string") patch({ key_path: sel });
  };

  const save = async () => {
    if (invalid) return;
    setSaving(true);
    setError(null);
    try {
      await storeSecret(draft.id);
      await saveServer(current());
      wroteSecret.current = false;
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const close = (o: boolean) => {
    if (!o && wroteSecret.current) void deleteServerSecret(draft.id).catch(() => {});
    onOpenChange(o);
  };

  const sftp = draft.protocol === "sftp";
  const usesKey = sftp && draft.auth === "key";
  const secretLabel = usesKey ? t("Key passphrase") : t("Password");
  const needsTrust = sftp && !draft.host_key;

  return (
    <Dialog open={isOpen} onOpenChange={close}>
      <DialogContent
        className="w-[min(600px,94vw)]"
        title={server ? t("Edit server") : t("Add server")}
        desc={t("Where this project uploads to. Passwords go to the system keychain, never to Assay's database.")}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t("Protocol")}>
              <Choice
                label={t("Protocol")}
                value={draft.protocol}
                onChange={setProtocol}
                options={(["sftp", "ftp", "ftps"] as const).map((p) => ({ value: p, label: PROTOCOL_LABEL[p] }))}
              />
            </Field>
            <div className="min-w-[160px] flex-1">
              <Field label={t("Name")}>
                <Input
                  value={draft.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder={draft.host || t("Production")}
                />
              </Field>
            </div>
          </div>

          <div className="grid grid-cols-[1fr_88px] gap-3">
            <Field label={t("Host")} htmlFor="srv-host">
              <Input
                id="srv-host"
                value={draft.host}
                autoFocus={!server}
                onChange={(e) => patch({ host: e.target.value })}
                placeholder="example.com"
                className="font-mono text-xs"
              />
            </Field>
            <Field label={t("Port")} htmlFor="srv-port">
              <Input
                id="srv-port"
                inputMode="numeric"
                value={String(draft.port || "")}
                onChange={(e) => patch({ port: Number(e.target.value.replace(/\D/g, "")) || 0 })}
                className="tnum font-mono text-xs"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("User")} htmlFor="srv-user">
              <Input
                id="srv-user"
                value={draft.username}
                onChange={(e) => patch({ username: e.target.value })}
                placeholder="deploy"
                className="font-mono text-xs"
              />
            </Field>
            {sftp && (
              <Field label={t("Log in with")}>
                <Choice<DeployAuth>
                  label={t("Log in with")}
                  value={draft.auth}
                  onChange={(auth) => patch({ auth })}
                  options={[
                    { value: "password", label: t("Password") },
                    { value: "key", label: t("SSH key") },
                  ]}
                />
              </Field>
            )}
          </div>

          {usesKey && (
            <Field
              label={t("Private key")}
              hint={t("Empty tries ~/.ssh/id_ed25519, id_ecdsa and id_rsa, the way ssh does.")}
              htmlFor="srv-key"
            >
              <div className="flex gap-2">
                <Input
                  id="srv-key"
                  value={draft.key_path ?? ""}
                  onChange={(e) => patch({ key_path: e.target.value })}
                  placeholder="~/.ssh/id_ed25519"
                  className="font-mono text-xs"
                />
                <Button variant="secondary" type="button" onClick={() => void pickKey()}>
                  <FolderOpen className="h-3.5 w-3.5" /> {t("Browse")}
                </Button>
              </div>
            </Field>
          )}

          <Field
            label={secretLabel}
            hint={usesKey ? t("Only if the key has one.") : undefined}
            htmlFor="srv-secret"
          >
            {secretSaved && !replacing ? (
              <div className="flex h-8 items-center gap-2 text-[12px] text-text-2">
                <KeyRound className="h-3.5 w-3.5 text-success" />
                <span className="flex-1">{t("Saved in the system keychain")}</span>
                <Button variant="ghost" size="sm" onClick={() => setReplacing(true)}>
                  {t("Replace")}
                </Button>
              </div>
            ) : (
              <Input
                id="srv-secret"
                type="password"
                autoComplete="new-password"
                value={secret}
                autoFocus={replacing}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={usesKey ? t("none") : ""}
              />
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Remote folder")} hint={t("Where the files land on the server.")} htmlFor="srv-remote">
              <Input
                id="srv-remote"
                value={draft.remote_path}
                onChange={(e) => patch({ remote_path: e.target.value })}
                placeholder="/var/www/site"
                className="font-mono text-xs"
              />
            </Field>
            <Field label={t("Local folder")} hint={t("Relative to the project. Empty uploads all of it.")} htmlFor="srv-local">
              <Input
                id="srv-local"
                value={draft.local_dir}
                onChange={(e) => patch({ local_dir: e.target.value })}
                placeholder="dist"
                className="font-mono text-xs"
              />
            </Field>
          </div>

          <Field
            label={t("Never upload")}
            hint={t("One pattern per line. A name matches anywhere (node_modules, *.log); a path with / starts at the local folder.")}
            htmlFor="srv-excludes"
          >
            <Textarea
              id="srv-excludes"
              rows={4}
              value={excludesText}
              onChange={(e) => setExcludesText(e.target.value)}
              className="font-mono text-[11px]"
            />
          </Field>

          <SwitchField
            label={t("Upload automatically")}
            hint={t("Sends what changed a few seconds after it lands on disk, whoever wrote it. Never deletes on the server.")}
            checked={draft.auto_upload}
            onCheckedChange={(v) => patch({ auto_upload: v })}
          />
          {!first && (
            <SwitchField
              label={t("Default server")}
              hint={t("The one the Upload button and the footer count use.")}
              checked={draft.is_default}
              onCheckedChange={(v) => patch({ is_default: v })}
            />
          )}

          <TestOutcome result={result} error={error} host={draft.host.trim()} onTrust={trust} />
        </div>

        <div className="mt-5 flex items-center gap-2">
          <Button
            variant="secondary"
            loading={testing}
            disabled={!!invalid}
            title={invalid ?? undefined}
            onClick={() => void runTest()}
          >
            <PlugZap className="h-3.5 w-3.5" /> {t("Test connection")}
          </Button>
          {needsTrust && !result && (
            <span className="text-[11px] text-text-3">{t("Test once to accept the server's key.")}</span>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={() => close(false)}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" loading={saving} disabled={!!invalid} title={invalid ?? undefined} onClick={() => void save()}>
            {server ? t("Save") : t("Add server")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
