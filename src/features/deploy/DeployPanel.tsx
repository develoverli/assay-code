import * as Dropdown from "@radix-ui/react-dropdown-menu";
import * as Switch from "@radix-ui/react-switch";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  Check,
  CloudUpload,
  FileJson,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  X,
} from "lucide-react";
import * as React from "react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/primitives";
import {
  PROTOCOL_LABEL,
  parseSftpJson,
  serverAddress,
  setServerSecret,
  toSftpJson,
  cancelUpload,
  type DeployChange,
  type ServerDraft,
} from "@/lib/deploy";
import { useDates } from "@/lib/dates";
import { useT } from "@/lib/i18n";
import { cn, now, uid } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useBench } from "@/store/bench";
import { useShallow } from "zustand/react/shallow";
import { pendingFor, useDeploy, type LastUpload, type ServerScan } from "@/store/deploy";
import type { DeployServer, Project } from "@/types";
import { fileGlyph } from "@/features/bench/icons";
import { ServerDialog } from "./ServerDialog";

/**
 * Deploy, in Workspace's dock: what differs from what the server last received,
 * ticked by default. Deletions are listed apart and never ticked on their own;
 * every upload confirms first, deletions behind a danger confirmation.
 */

const SFTP_JSON = ".vscode/sftp.json";

const KIND_MARK: Record<DeployChange["kind"], { letter: string; tone: string; label: string }> = {
  added: { letter: "A", tone: "text-success", label: "new" },
  modified: { letter: "M", tone: "text-warn", label: "modified" },
  deleted: { letter: "D", tone: "text-danger", label: "deleted here" },
};

const menuItem =
  "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-text-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-text";

function joinPath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${rel}`;
}

/* ------------------------------ no server yet ------------------------------ */

function FirstServer({ project, onAdd }: { project: Project; onAdd: () => void }) {
  const t = useT();
  const saveServer = useDeploy((s) => s.saveServer);
  const setError = useBench((s) => s.setError);
  const [found, setFound] = React.useState<ServerDraft[] | null>(null);
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const root = project.path ?? "";

  React.useEffect(() => {
    let alive = true;
    const file = joinPath(root, SFTP_JSON);
    void exists(file)
      .then(async (yes) => {
        if (!yes || !alive) return;
        try {
          const drafts = parseSftpJson(await readTextFile(file));
          if (alive) setFound(drafts);
        } catch (e) {
          if (alive) setParseError(e instanceof Error ? e.message : String(e));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [root]);

  const importAll = async () => {
    if (!found) return;
    setImporting(true);
    try {
      for (const d of found) {
        const id = uid("srv_");
        // a password written into the file moves to the keychain; the file keeps its copy
        if (d.secret) await setServerSecret(id, d.secret);
        const { secret: _secret, ...rest } = d;
        await saveServer({
          ...rest,
          id,
          project_id: project.id,
          host_key: null,
          auto_upload: false,
          last_deploy_at: null,
          created_at: now(),
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 px-3 py-4 text-[12px] text-text-2">
      <div>
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-text">
          <CloudUpload className="h-4 w-4 text-text-3" /> {t("No server yet")}
        </p>
        <p className="mt-1.5 leading-relaxed">
          {t("Upload what changed to your server over SFTP or FTP, including what an agent wrote without anyone pressing Save.")}
        </p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-text-3">
          {t("Only for projects that live on a server you reach by SFTP or FTP (a hosting, a VPS). If this one is deployed another way, you can ignore this panel.")}
        </p>
      </div>
      {found && found.length > 0 && (
        <div className="rounded-md border border-accent/30 bg-accent-soft/40 p-2.5">
          <p className="flex items-center gap-1.5 font-medium text-text">
            <FileJson className="h-3.5 w-3.5 text-accent" /> {t("This project has {file}", { file: SFTP_JSON })}
          </p>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {found.map((d) => (
              <li key={d.name} className="truncate font-mono text-[11px] text-text-3" title={serverAddress(d)}>
                <span className="text-text-2">{d.name}</span> · {PROTOCOL_LABEL[d.protocol]} · {serverAddress(d)}
              </li>
            ))}
          </ul>
          <Button variant="primary" size="sm" className="mt-2.5" loading={importing} onClick={() => void importAll()}>
            {found.length === 1 ? t("Use this server") : t("Use these {n} servers", { n: found.length })}
          </Button>
        </div>
      )}
      {parseError && (
        <p className="selectable text-[11px] text-danger">
          {t("{file} could not be read: {error}", { file: SFTP_JSON, error: parseError })}
        </p>
      )}
      <Button variant={found?.length ? "secondary" : "primary"} size="sm" className="self-start" onClick={onAdd}>
        <Plus className="h-3.5 w-3.5" /> {t("Add server")}
      </Button>
    </div>
  );
}

/* ------------------------------- server bar -------------------------------- */

function ServerMenu({
  servers,
  current,
  onPick,
  onEdit,
  onAdd,
  onExport,
  onRemove,
  onDefault,
}: {
  servers: DeployServer[];
  current: DeployServer;
  onPick: (id: string) => void;
  onEdit: () => void;
  onAdd: () => void;
  onExport: () => void;
  onRemove: () => void;
  onDefault: () => void;
}) {
  const t = useT();
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          title={t("Server options")}
          aria-label={t("Server options")}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent data-[state=open]:bg-surface-2 data-[state=open]:text-text"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[240px] rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
        >
          {servers.length > 1 && (
            <>
              {servers.map((s) => (
                <Dropdown.Item key={s.id} className={menuItem} onSelect={() => onPick(s.id)}>
                  <Check className={cn("h-3.5 w-3.5 shrink-0", s.id !== current.id && "invisible")} />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  {s.is_default && <Star className="h-3 w-3 shrink-0 text-text-3" aria-label={t("Default")} />}
                </Dropdown.Item>
              ))}
              <Dropdown.Separator className="my-1 h-px bg-border" />
            </>
          )}
          <Dropdown.Item className={menuItem} onSelect={onEdit}>
            <Pencil className="h-3.5 w-3.5" /> {t("Edit server…")}
          </Dropdown.Item>
          {!current.is_default && (
            <Dropdown.Item className={menuItem} onSelect={onDefault}>
              <Star className="h-3.5 w-3.5" /> {t("Make it the default")}
            </Dropdown.Item>
          )}
          <Dropdown.Item className={menuItem} onSelect={onAdd}>
            <Plus className="h-3.5 w-3.5" /> {t("Add server…")}
          </Dropdown.Item>
          <Dropdown.Item className={menuItem} onSelect={onExport}>
            <FileJson className="h-3.5 w-3.5" /> {t("Save as {file}…", { file: SFTP_JSON })}
          </Dropdown.Item>
          <Dropdown.Separator className="my-1 h-px bg-border" />
          <Dropdown.Item
            className={cn(menuItem, "text-danger data-[highlighted]:bg-danger/10 data-[highlighted]:text-danger")}
            onSelect={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" /> {t("Remove server…")}
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/* -------------------------------- change list ------------------------------ */

function ChangeRow({
  change,
  checked,
  onToggle,
  onOpen,
}: {
  change: DeployChange;
  checked: boolean;
  onToggle: () => void;
  onOpen?: () => void;
}) {
  const t = useT();
  const name = change.path.split("/").pop() ?? change.path;
  const { Icon, tone } = fileGlyph(name);
  const mark = KIND_MARK[change.kind];
  return (
    <div className="flex items-center gap-1.5 px-2 py-[3px] text-[12px] hover:bg-surface-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={t("Include {file}", { file: change.path })}
        className="h-3 w-3 shrink-0 cursor-pointer accent-[var(--color-accent)]"
      />
      <span className={cn("w-4 shrink-0 font-mono text-[10px]", mark.tone)} title={t(mark.label)} aria-label={t(mark.label)}>
        {mark.letter}
      </span>
      <Icon className={cn("h-3.5 w-3.5 shrink-0", tone)} />
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          title={change.path}
          className="min-w-0 flex-1 cursor-pointer truncate text-left text-text-2 transition-colors hover:text-text"
        >
          {change.path}
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate text-text-3 line-through decoration-text-3/50" title={change.path}>
          {change.path}
        </span>
      )}
    </div>
  );
}

/** A header checkbox that can be partial: `indeterminate` only exists on the DOM node. */
function AllBox({ total, picked, onAll, label }: { total: number; picked: number; onAll: (all: boolean) => void; label: string }) {
  const ref = React.useRef<HTMLInputElement>(null);
  const all = total > 0 && picked === total;
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = picked > 0 && !all;
  }, [picked, all]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={all}
      onChange={() => onAll(!all)}
      aria-label={label}
      className="h-3 w-3 shrink-0 cursor-pointer accent-[var(--color-accent)]"
    />
  );
}

/* ------------------------------ load and scan ------------------------------ */

/**
 * One load + scan per project folder at a time. The footer chip and this panel both ask on
 * mount, and they mount together whenever Workspace opens with Deploy in front — without the
 * guard the whole tree was hashed twice.
 */
const scansInFlight = new Map<string, Promise<void>>();

function loadAndScan(project: Project): Promise<void> {
  const key = `${project.id}|${project.path ?? ""}`;
  const running = scansInFlight.get(key);
  if (running) return running;
  const { loadServers, scan } = useDeploy.getState();
  const job = loadServers(project.id)
    .then((list) => (list.length ? scan(project) : undefined))
    .finally(() => scansInFlight.delete(key));
  scansInFlight.set(key, job);
  return job;
}

/**
 * Loads the project's servers and scans them when the project or its folder changes — not on
 * every new project object the store hands down (touching a project replaces it). The latest
 * object is read through a ref, so the effect's dependencies are exactly what it reacts to.
 */
export function useLoadAndScan(project: Project): void {
  const latest = React.useRef(project);
  React.useEffect(() => {
    latest.current = project;
  });
  const { id, path } = project;
  React.useEffect(() => {
    void loadAndScan(latest.current);
  }, [id, path]);
}

/* ---------------------------------- panel ---------------------------------- */

export function DeployPanel({ project }: { project: Project }) {
  const t = useT();
  const dates = useDates();
  const root = project.path ?? "";
  const servers = useDeploy((s) => s.servers[project.id]);
  const loadServers = useDeploy((s) => s.loadServers);
  const scanAll = useDeploy((s) => s.scan);
  const upload = useDeploy((s) => s.upload);
  const markUploaded = useDeploy((s) => s.markUploaded);
  const deleteServer = useDeploy((s) => s.deleteServer);
  const setDefault = useDeploy((s) => s.setDefault);
  const setAutoUpload = useDeploy((s) => s.setAutoUpload);
  const askNewServer = useDeploy((s) => s.askNewServer);
  const loadError = useDeploy((s) => s.loadErrors[project.id]);
  const setAskNewServer = useDeploy((s) => s.setAskNewServer);
  const syncWatchers = useDeploy((s) => s.syncWatchers);
  const openPath = useBench((s) => s.openPath);
  const setError = useBench((s) => s.setError);

  const [currentId, setCurrentId] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<null | "add" | "edit">(null);
  const [asking, setAsking] = React.useState<null | "upload" | "remove" | "export" | "baseline">(null);
  const [unpicked, setUnpicked] = React.useState<Set<string>>(() => new Set());
  const [pickedDeletes, setPickedDeletes] = React.useState<Set<string>>(() => new Set());

  const current = servers?.find((s) => s.id === currentId) ?? servers?.find((s) => s.is_default) ?? servers?.[0] ?? null;
  const scan: ServerScan | undefined = useDeploy((s) => (current ? s.scans[current.id] : undefined));
  const job = useDeploy((s) => (current ? s.jobs[current.id] : undefined));
  const last = useDeploy((s) => (current ? s.last[current.id] : undefined));
  const scanning = useDeploy((s) => (current ? !!s.scanning[current.id] : false));

  useLoadAndScan(project);

  // the project on screen is watched while it has servers, so the list follows the agents
  const serverCount = servers?.length ?? 0;
  const projects = useApp((s) => s.projects);
  React.useEffect(() => {
    void syncWatchers(projects, project.id);
  }, [serverCount, project.id, projects, syncWatchers]);

  // a project created with "publishes to a server" lands here with the form open
  React.useEffect(() => {
    if (askNewServer === project.id) {
      setDialog("add");
      setAskNewServer(null);
    }
  }, [askNewServer, project.id, setAskNewServer]);

  // picks are kept by path so they survive the watcher's rescans; reset per server
  React.useEffect(() => {
    setUnpicked(new Set());
    setPickedDeletes(new Set());
  }, [current?.id]);

  if (!servers && loadError) {
    return (
      <div className="flex flex-col gap-2 px-3 py-4 text-[12px] text-text-2">
        <p>{t("The deploy servers could not be read.")}</p>
        <p className="selectable rounded-md border border-danger/30 bg-danger/10 px-2.5 py-2 font-mono text-[11px] text-danger">
          {loadError}
        </p>
        {/no such table/i.test(loadError) && (
          <p className="text-[11px] text-text-3">
            {t("The database update that creates Deploy's tables did not run. Install the latest build and open Assay again: it runs then.")}
          </p>
        )}
        <Button variant="secondary" size="sm" className="self-start" onClick={() => void loadServers(project.id)}>
          <RefreshCw className="h-3.5 w-3.5" /> {t("Try again")}
        </Button>
      </div>
    );
  }
  if (!servers) return <p className="px-3 py-3 text-[11px] text-text-3">{t("reading…")}</p>;

  const dialogs = (
    <ServerDialog
      open={dialog !== null}
      onOpenChange={(o) => !o && setDialog(null)}
      projectId={project.id}
      server={dialog === "edit" ? current : null}
      first={servers.length === 0}
    />
  );

  if (!current) {
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <FirstServer project={project} onAdd={() => setDialog("add")} />
        {dialogs}
      </div>
    );
  }

  const uploads = scan?.uploads ?? [];
  const deletions = scan?.deletions ?? [];
  const chosenUploads = uploads.filter((c) => !unpicked.has(c.path));
  const chosenDeletes = deletions.filter((c) => pickedDeletes.has(c.path));
  const count = chosenUploads.length + chosenDeletes.length;
  const busy = !!job;

  const toggleUpload = (path: string) =>
    setUnpicked((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const toggleDelete = (path: string) =>
    setPickedDeletes((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const run = (fn: () => Promise<void>) => {
    void fn().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const exportJson = () =>
    run(async () => {
      await mkdir(joinPath(root, ".vscode"), { recursive: true });
      await writeTextFile(joinPath(root, SFTP_JSON), toSftpJson(servers));
    });

  let uploadTitle: string | undefined;
  if (busy) uploadTitle = t("An upload to this server is already running");
  else if (!count) uploadTitle = t("Nothing is selected to upload");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* which server, where it lands, and whether it follows the disk on its own */}
      <div className="shrink-0 border-b border-border-soft px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <CloudUpload className="h-3.5 w-3.5 shrink-0 text-brass" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-text" title={current.name}>
            {current.name}
          </span>
          <span className="shrink-0 rounded border border-border px-1 text-[9px] font-medium uppercase tracking-wide text-text-3">
            {PROTOCOL_LABEL[current.protocol]}
          </span>
          <button
            type="button"
            onClick={() => void scanAll(project, current.id)}
            title={t("Look for changes again")}
            aria-label={t("Look for changes again")}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            <RefreshCw className={cn("h-3 w-3", scanning && "animate-spin")} />
          </button>
          <ServerMenu
            servers={servers}
            current={current}
            onPick={setCurrentId}
            onEdit={() => setDialog("edit")}
            onAdd={() => setDialog("add")}
            onExport={() => setAsking("export")}
            onRemove={() => setAsking("remove")}
            onDefault={() => run(() => setDefault(project.id, current.id))}
          />
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="selectable min-w-0 flex-1 truncate font-mono text-[10px] text-text-3" title={serverAddress(current)}>
            {serverAddress(current)}
          </span>
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[10px] text-text-3">
            {t("Auto")}
            <Switch.Root
              checked={current.auto_upload}
              onCheckedChange={(v) => run(() => setAutoUpload(current, v))}
              aria-label={t("Upload automatically")}
              title={t("Upload what changes a few seconds after it lands on disk. Never deletes on the server.")}
              className="relative h-3.5 w-6 cursor-pointer rounded-full bg-surface-3 transition-colors data-[state=checked]:bg-accent"
            >
              <Switch.Thumb className="block h-2.5 w-2.5 translate-x-0.5 rounded-full bg-text transition-transform data-[state=checked]:translate-x-[12px]" />
            </Switch.Root>
          </label>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {scan?.error && (
          <p className="selectable m-2 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-2 text-[11px] text-danger">
            {scan.error}
          </p>
        )}

        {/* first contact: every file looks new because nobody has said what the server holds */}
        {scan?.fresh && uploads.length > 0 && !busy && (
          <div className="m-2 rounded-md border border-border bg-surface-2 p-2.5 text-[11px] leading-relaxed text-text-2">
            <p>
              {t("Nothing has been uploaded to this server from Assay yet, so all {n} files look new. If the server already has this project, mark it as uploaded: from then on only what changes is sent.", { n: uploads.length })}
            </p>
            <Button variant="secondary" size="sm" className="mt-2" onClick={() => setAsking("baseline")}>
              <Check className="h-3.5 w-3.5" /> {t("Mark all as uploaded")}
            </Button>
          </div>
        )}

        <div className="flex items-center gap-1.5 px-2 pt-2">
          {uploads.length > 0 && (
            <AllBox
              total={uploads.length}
              picked={chosenUploads.length}
              onAll={(all) => setUnpicked(all ? new Set() : new Set(uploads.map((c) => c.path)))}
              label={t("Include every change")}
            />
          )}
          <p className="text-[10px] uppercase tracking-wide text-text-3">
            {uploads.length === 1 ? t("1 file to upload") : t("{n} files to upload", { n: uploads.length })}
          </p>
        </div>
        {uploads.length === 0 && !scan?.error ? (
          <p className="px-2 py-1.5 text-[11px] text-text-3">
            {scan
              ? current.last_deploy_at
                ? t("Everything is on the server. Last upload {when}.", { when: dates.ago(current.last_deploy_at) })
                : t("Nothing differs from what the server last received.")
              : t("reading…")}
          </p>
        ) : (
          <div className="py-1">
            {uploads.map((c) => (
              <ChangeRow
                key={c.path}
                change={c}
                checked={!unpicked.has(c.path)}
                onToggle={() => toggleUpload(c.path)}
                onOpen={() => void openPath(joinPath(current.local_dir ? joinPath(root, current.local_dir) : root, c.path), c.path.split("/").pop() ?? c.path)}
              />
            ))}
          </div>
        )}

        {deletions.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 border-t border-border-soft px-2 pt-2">
              <AllBox
                total={deletions.length}
                picked={chosenDeletes.length}
                onAll={(all) => setPickedDeletes(all ? new Set(deletions.map((c) => c.path)) : new Set())}
                label={t("Delete every one of these on the server")}
              />
              <p className="text-[10px] uppercase tracking-wide text-text-3">
                {t("Deleted here ({n})", { n: deletions.length })}
              </p>
            </div>
            <p className="px-2 pb-1 text-[10px] text-text-3">{t("Still on the server. Tick one to delete it there too.")}</p>
            <div className="pb-1">
              {deletions.map((c) => (
                <ChangeRow key={c.path} change={c} checked={pickedDeletes.has(c.path)} onToggle={() => toggleDelete(c.path)} />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-surface p-2">
        {job ? (
          <div aria-live="polite">
            <div className="flex items-center gap-2 text-[11px] text-text-2">
              <span className="tnum shrink-0">
                {job.done} / {job.total}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-3" title={job.current}>
                {job.current || t("connecting…")}
              </span>
              <Button variant="ghost" size="sm" onClick={() => void cancelUpload(job.jobId)}>
                <X className="h-3.5 w-3.5" /> {t("Stop")}
              </Button>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full w-full origin-left bg-accent transition-transform duration-200 ease-out"
                style={{ transform: `scaleX(${job.total ? job.done / job.total : 0})` }}
              />
            </div>
          </div>
        ) : (
          <>
            <Button
              variant="primary"
              size="sm"
              className="w-full"
              disabled={!count}
              title={uploadTitle}
              onClick={() => setAsking("upload")}
            >
              <CloudUpload className="h-3.5 w-3.5" />
              {chosenDeletes.length
                ? t("Upload {n} · delete {d}", { n: chosenUploads.length, d: chosenDeletes.length })
                : t("Upload {n}", { n: chosenUploads.length })}
            </Button>
            {last && <LastResult last={last} />}
          </>
        )}
      </div>

      {dialogs}

      <ConfirmDialog
        open={asking === "upload"}
        onOpenChange={(o) => !o && setAsking(null)}
        danger={chosenDeletes.length > 0}
        title={t("Upload to {server}?", { server: current.name })}
        confirmLabel={chosenDeletes.length ? t("Upload and delete") : t("Upload")}
        body={
          <>
            <p>
              {t("{n} files go to {where}.", { n: chosenUploads.length, where: serverAddress(current) })}
            </p>
            {chosenDeletes.length > 0 && (
              <p className="mt-2 text-danger">
                {t("{n} files will be deleted on the server. That cannot be undone from here.", { n: chosenDeletes.length })}
              </p>
            )}
          </>
        }
        onConfirm={() => void upload(project, current, chosenUploads, chosenDeletes)}
      />
      <ConfirmDialog
        open={asking === "baseline"}
        onOpenChange={(o) => !o && setAsking(null)}
        title={t("Mark everything as uploaded?")}
        confirmLabel={t("Mark as uploaded")}
        body={
          <p>
            {t("Assay records the files as they are now as already on {server}. Nothing is sent. Only what changes after this will be uploaded.", { server: current.name })}
          </p>
        }
        onConfirm={() => run(() => markUploaded(project, current))}
      />
      <ConfirmDialog
        open={asking === "export"}
        onOpenChange={(o) => !o && setAsking(null)}
        title={t("Save {file}?", { file: SFTP_JSON })}
        confirmLabel={t("Save")}
        body={
          <>
            <p>
              {t("Writes this project's servers into {file} for VS Code's SFTP extension, replacing that file if it exists. Passwords are not written.", { file: SFTP_JSON })}
            </p>
            <pre className="selectable mt-2 max-h-48 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[11px] text-text-2">
              {toSftpJson(servers)}
            </pre>
          </>
        }
        onConfirm={exportJson}
      />
      <ConfirmDialog
        open={asking === "remove"}
        onOpenChange={(o) => !o && setAsking(null)}
        danger
        title={t("Remove {server}?", { server: current.name })}
        confirmLabel={t("Remove")}
        body={
          <p>
            {t("Assay forgets this server, its saved password and what it last received. Nothing on the server is touched.")}
          </p>
        }
        onConfirm={() =>
          run(async () => {
            setCurrentId(null);
            await deleteServer(current);
          })
        }
      />
    </div>
  );
}

function LastResult({ last }: { last: LastUpload }) {
  const t = useT();
  const dates = useDates();
  if (last.error) {
    return (
      <p className="selectable mt-1.5 text-[11px] text-danger" title={last.error}>
        {last.error}
      </p>
    );
  }
  const sent = last.uploaded.length;
  const removed = last.deleted.length;
  return (
    <div className="mt-1.5 text-[11px]">
      <p className={cn(last.failed.length ? "text-warn" : "text-text-3")}>
        {last.cancelled && `${t("Stopped")} · `}
        {t("{n} uploaded", { n: sent })}
        {removed > 0 && ` · ${t("{n} deleted", { n: removed })}`}
        {last.failed.length > 0 && ` · ${t("{n} failed", { n: last.failed.length })}`}
        {" · "}
        {last.auto ? t("automatically") : ""} {dates.ago(last.at)}
      </p>
      {last.failed.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-text-3 hover:text-text-2">{t("What failed")}</summary>
          <ul className="selectable mt-1 max-h-32 overflow-auto font-mono text-[10px] text-text-3">
            {last.failed.map((f) => (
              <li key={f.path} className="truncate" title={`${f.path}: ${f.error}`}>
                <span className="text-danger">{f.path}</span> {f.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** For the footer: the default server's pending count, what an upload is doing, or a failure. */
export function useDeployBadge(projectId: string): { servers: number; pending: number; uploading: boolean; failed: boolean } {
  return useDeploy(
    useShallow((s) => {
        const list = s.servers[projectId] ?? [];
        const def = list.find((x) => x.is_default) ?? list[0];
        const lastUpload = def ? s.last[def.id] : undefined;
        return {
          servers: list.length,
          pending: def ? pendingFor(s.scans[def.id]) : 0,
          uploading: list.some((x) => !!s.jobs[x.id]),
          failed: !!lastUpload && (!!lastUpload.error || lastUpload.failed.length > 0),
        };
    }),
  );
}
