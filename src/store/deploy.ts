import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { watch, type UnwatchFn } from "@tauri-apps/plugin-fs";
import * as db from "@/lib/db";
import {
  changesOf,
  deleteServerSecret,
  PROGRESS_EVENT,
  scanServer,
  uploadToServer,
  type DeployChange,
  type UploadProgress,
  type UploadResult,
} from "@/lib/deploy";
import { notify } from "@/lib/notify";
import { tr } from "@/lib/i18n";
import { now, uid } from "@/lib/utils";
import type { DeployServer, Project } from "@/types";

/**
 * Deploy state: each project's servers, what differs from what each server last
 * received, the uploads in flight, and the folders watched for them. Watching
 * replaces upload-on-save: the project on screen keeps its pending count true
 * while an agent edits, and auto-upload projects send on their own.
 */

export interface ServerScan {
  uploads: DeployChange[];
  deletions: DeployChange[];
  /** Files looked at, excluded ones not counted. */
  files: number;
  at: number;
  /** The manifest is empty: nothing was ever uploaded from Assay to this server. */
  fresh: boolean;
  error: string | null;
}

interface UploadJob {
  jobId: string;
  done: number;
  total: number;
  current: string;
  failures: number;
  /** Started by the watcher rather than by a click. */
  auto: boolean;
}

export interface LastUpload extends UploadResult {
  at: number;
  auto: boolean;
  /** A failure before any file moved: login, host key, network. */
  error: string | null;
}

/** After the last write, how long the disk has to be quiet before a rescan. */
const WATCH_DELAY_MS = 3000;
/** Events inside these folders never change what Deploy would send. */
const NOISE = /(^|[\\/])(\.git|node_modules)([\\/]|$)/;

interface DeployState {
  servers: Record<string, DeployServer[]>;
  scans: Record<string, ServerScan>;
  jobs: Record<string, UploadJob>;
  last: Record<string, LastUpload>;
  scanning: Record<string, boolean>;
  /** Per project: why its servers could not be read. The panel says so instead of waiting forever. */
  loadErrors: Record<string, string>;
  /** A project just created with "publishes to a server": its Deploy panel opens on the new-server form. */
  askNewServer: string | null;
  setAskNewServer: (projectId: string | null) => void;
  loadServers: (projectId: string) => Promise<DeployServer[]>;
  /** Compare every server of a project (or just one) with the disk. */
  scan: (project: Project, serverId?: string) => Promise<void>;
  upload: (project: Project, server: DeployServer, uploads: DeployChange[], deletions: DeployChange[], auto?: boolean) => Promise<void>;
  /** Record the disk as already on the server, without sending anything. */
  markUploaded: (project: Project, server: DeployServer) => Promise<void>;
  saveServer: (server: DeployServer) => Promise<void>;
  deleteServer: (server: DeployServer) => Promise<void>;
  setDefault: (projectId: string, id: string) => Promise<void>;
  setAutoUpload: (server: DeployServer, on: boolean) => Promise<void>;
  /** Start and stop folder watchers to match the projects that need one. */
  syncWatchers: (projects: Project[], activeId: string | null) => Promise<void>;
}

/** Per project: the watcher and the path it watches. */
const watchers = new Map<string, { path: string; stop: UnwatchFn }>();
let progressListener: Promise<unknown> | null = null;

export const useDeploy = create<DeployState>((set, get) => {
  /** One listener for every job: progress lands on the server whose job it is. */
  const ensureListener = () => {
    progressListener ??= listen<UploadProgress>(PROGRESS_EVENT, (e) => {
      const p = e.payload;
      set((s) => {
        const entry = Object.entries(s.jobs).find(([, j]) => j.jobId === p.jobId);
        if (!entry) return s;
        const [serverId, job] = entry;
        return {
          jobs: {
            ...s.jobs,
            [serverId]: { ...job, done: p.done, total: p.total, current: p.path, failures: job.failures + (p.error ? 1 : 0) },
          },
        };
      });
    });
  };

  const scanOne = async (project: Project, server: DeployServer) => {
    if (!project.path) return;
    set((s) => ({ scanning: { ...s.scanning, [server.id]: true } }));
    try {
      const known = await db.deployManifest(server.id);
      const result = await scanServer(project.path, server, known);
      // same bytes under a new mtime: remember the new mtime, so the next scan
      // does not hash the file again, and send nothing
      if (result.touched.length) await db.updateDeployManifest(server.id, result.touched, [], null);
      const { uploads, deletions } = changesOf(result);
      set((s) => ({
        scans: {
          ...s.scans,
          [server.id]: { uploads, deletions, files: result.files, at: now(), fresh: known.length === 0, error: null },
        },
      }));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set((s) => ({
        scans: {
          ...s.scans,
          [server.id]: { uploads: [], deletions: [], files: 0, at: now(), fresh: false, error },
        },
      }));
    } finally {
      set((s) => ({ scanning: { ...s.scanning, [server.id]: false } }));
    }
  };

  /** The watcher's answer: rescan, then send what an auto-upload server is owed. */
  const onDiskChange = async (project: Project) => {
    const servers = get().servers[project.id] ?? (await get().loadServers(project.id));
    await get().scan(project);
    for (const server of servers) {
      if (!server.auto_upload || get().jobs[server.id]) continue;
      const scan = get().scans[server.id];
      // a server with an empty manifest would get the whole project on its first watch
      if (!scan || scan.error || scan.fresh || !scan.uploads.length) continue;
      // auto-upload sends, it never deletes
      await get().upload(project, server, scan.uploads, [], true);
    }
  };

  return {
    servers: {},
    scans: {},
    jobs: {},
    last: {},
    scanning: {},
    loadErrors: {},
    askNewServer: null,
    setAskNewServer: (askNewServer) => set({ askNewServer }),

    loadServers: async (projectId) => {
      try {
        const list = await db.listDeployServers(projectId);
        set((s) => {
          const loadErrors = { ...s.loadErrors };
          delete loadErrors[projectId];
          return { servers: { ...s.servers, [projectId]: list }, loadErrors };
        });
        return list;
      } catch (e) {
        // a failed read must end the wait: the panel shows why, with a retry
        const error = e instanceof Error ? e.message : String(e);
        set((s) => ({ loadErrors: { ...s.loadErrors, [projectId]: error } }));
        return [];
      }
    },

    scan: async (project, serverId) => {
      const servers = get().servers[project.id] ?? (await get().loadServers(project.id));
      await Promise.all(servers.filter((s) => !serverId || s.id === serverId).map((s) => scanOne(project, s)));
    },

    upload: async (project, server, uploads, deletions, auto = false) => {
      if (!project.path || get().jobs[server.id]) return;
      ensureListener();
      await progressListener;
      const jobId = uid("dep_");
      const total = uploads.length + deletions.length;
      set((s) => ({
        jobs: { ...s.jobs, [server.id]: { jobId, done: 0, total, current: "", failures: 0, auto } },
      }));
      let outcome: LastUpload;
      try {
        const res = await uploadToServer(
          jobId,
          project.path,
          server,
          uploads.map((c) => c.path),
          deletions.map((c) => c.path),
        );
        // the manifest takes exactly what the server confirmed, nothing it refused
        const sent = new Set(res.uploaded);
        const files = uploads.flatMap((c) => (c.file && sent.has(c.path) ? [c.file] : []));
        await db.updateDeployManifest(server.id, files, res.deleted, res.uploaded.length || res.deleted.length ? now() : null);
        outcome = { ...res, at: now(), auto, error: null };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        outcome = { uploaded: [], deleted: [], failed: [], cancelled: false, at: now(), auto, error };
      }
      set((s) => {
        const jobs = { ...s.jobs };
        delete jobs[server.id];
        return { jobs, last: { ...s.last, [server.id]: outcome } };
      });
      // nobody is watching an auto-upload: a failure has to reach them anyway
      if (auto && (outcome.error || outcome.failed.length)) {
        void notify(
          tr("Deploy to {server} failed", { server: server.name }),
          outcome.error ?? tr("{n} files were not uploaded", { n: outcome.failed.length }),
        );
      }
      await get().loadServers(project.id);
      await scanOne(project, get().servers[project.id]?.find((s) => s.id === server.id) ?? server);
    },

    markUploaded: async (project, server) => {
      if (!project.path) return;
      const known = await db.deployManifest(server.id);
      const res = await scanServer(project.path, server, known);
      await db.updateDeployManifest(server.id, [...res.added, ...res.modified, ...res.touched], res.deleted, null);
      await scanOne(project, server);
    },

    saveServer: async (server) => {
      await db.saveDeployServer(server);
      await get().loadServers(server.project_id);
    },

    deleteServer: async (server) => {
      await db.deleteDeployServer(server.id);
      // the keychain entry goes with it; a failure there must not keep the row
      await deleteServerSecret(server.id).catch(() => {});
      set((s) => {
        const scans = { ...s.scans };
        delete scans[server.id];
        return { scans };
      });
      await get().loadServers(server.project_id);
    },

    setDefault: async (projectId, id) => {
      await db.setDefaultDeployServer(projectId, id);
      await get().loadServers(projectId);
    },

    setAutoUpload: async (server, on) => {
      await db.setDeployAutoUpload(server.id, on);
      await get().loadServers(server.project_id);
    },

    syncWatchers: async (projects, activeId) => {
      const auto = await db.listAutoDeployServers();
      const wanted = new Map<string, Project>();
      for (const p of projects) {
        if (!p.path) continue;
        const onScreen = p.id === activeId && (get().servers[p.id]?.length ?? 0) > 0;
        if (onScreen || auto.some((s) => s.project_id === p.id)) wanted.set(p.id, p);
      }
      for (const [id, w] of watchers) {
        const p = wanted.get(id);
        if (!p || p.path !== w.path) {
          w.stop();
          watchers.delete(id);
        }
      }
      for (const [id, p] of wanted) {
        if (watchers.has(id) || !p.path) continue;
        const path = p.path;
        try {
          const stop = await watch(
            path,
            (event) => {
              if (event.paths.length && event.paths.every((x) => NOISE.test(x.slice(path.length)))) return;
              void onDiskChange(p);
            },
            { recursive: true, delayMs: WATCH_DELAY_MS },
          );
          // a second sync may have raced this one while the watcher was starting
          if (watchers.has(id)) stop();
          else watchers.set(id, { path, stop });
        } catch {
          /* a folder that cannot be watched still deploys by hand */
        }
      }
    },
  };
});

/** How many changes a scan has pending. */
export function pendingFor(scan: ServerScan | undefined): number {
  return scan ? scan.uploads.length + scan.deletions.length : 0;
}
