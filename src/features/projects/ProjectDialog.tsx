import { FolderOpen } from "lucide-react";
import * as React from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/store/app";
import { useBench } from "@/store/bench";
import { useDeploy } from "@/store/deploy";
import { useUI } from "@/store/ui";
import { detectStack } from "@/lib/detect";
import type { Project } from "@/types";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { TagPicker } from "@/features/projects/Tags";
import { Badge, Button, Field, Input, SwitchField } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";

const basename = (p: string) => {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? "";
};

/** The form's fields move together, so one action describes the whole edit. */
interface Draft {
  name: string;
  path: string;
  url: string;
  authorized: boolean;
  detected: string[];
  tags: string[];
}

type DraftAction = { type: "reset"; project?: Project | null } | { type: "patch"; patch: Partial<Draft> };

function draftReducer(state: Draft, action: DraftAction): Draft {
  switch (action.type) {
    case "reset":
      return {
        name: action.project?.name ?? "",
        path: action.project?.path ?? "",
        url: action.project?.url ?? "",
        authorized: action.project?.authorized ?? false,
        detected: action.project?.stack ?? [],
        tags: action.project?.tags ?? [],
      };
    case "patch":
      return { ...state, ...action.patch };
  }
}

const EMPTY_DRAFT: Draft = { name: "", path: "", url: "", authorized: false, detected: [], tags: [] };

export function ProjectDialog({
  open: isOpen,
  onOpenChange,
  project,
  focus,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  project?: Project | null;
  /** Open with this field focused — for a button that asked for exactly it. */
  focus?: "url";
}) {
  const createProject = useApp((s) => s.createProject);
  const updateProject = useApp((s) => s.updateProject);
  const setProjectTags = useApp((s) => s.setProjectTags);
  const setError = useApp((s) => s.setError);
  const t = useT();
  const [draft, dispatch] = React.useReducer(draftReducer, EMPTY_DRAFT);
  const { name, path, url, authorized, detected, tags } = draft;
  const [busy, setBusy] = React.useState(false);
  /** New project only: go straight to its Deploy panel with the server form open. */
  const [deploys, setDeploys] = React.useState(false);

  React.useEffect(() => {
    if (!isOpen) return;
    dispatch({ type: "reset", project });
    setDeploys(false);
  }, [isOpen, project]);

  const pickFolder = async () => {
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") {
      dispatch({ type: "patch", patch: { path: sel, name: basename(sel) } });
      // auto-detect the stack from the folder
      dispatch({ type: "patch", patch: { detected: await detectStack(sel) } });
    }
  };

  const save = async () => {
    if (!path.trim() && !url.trim()) return setError(t("Add a local folder or a URL (or both)."));
    // name defaults to the folder name, else the URL host
    let finalName = name.trim();
    if (!finalName) {
      finalName = path.trim()
        ? basename(path.trim())
        : (() => {
            try {
              return new URL(url.trim()).hostname;
            } catch {
              return "project";
            }
          })();
    }
    setBusy(true);
    try {
      const stack = path.trim() ? await detectStack(path.trim()) : [];
      const data = {
        name: finalName,
        path: path.trim() || null,
        url: url.trim() || null,
        stack,
        authorized,
      };
      const id = project ? (await updateProject(project.id, data), project.id) : (await createProject(data)).id;
      await setProjectTags(id, tags);
      onOpenChange(false);
      if (!project && deploys && data.path) {
        useDeploy.getState().setAskNewServer(id);
        useBench.getState().openDock("deploy");
        useUI.getState().setView("bench");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent title={project ? t("Edit project") : t("Add project")}>
        <div className="flex flex-col gap-4">
          <Field label={t("Local folder")} hint={t("For code scans and agentic fixes.")}>
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(e) => dispatch({ type: "patch", patch: { path: e.target.value } })}
                placeholder="C:\path\to\project"
                className="font-mono text-xs"
              />
              <Button variant="secondary" onClick={pickFolder} type="button">
                <FolderOpen className="h-3.5 w-3.5" /> {t("Browse")}
              </Button>
            </div>
          </Field>
          {detected.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 -mt-1.5">
              <span className="text-[11px] text-text-3">{t("Detected:")}</span>
              {detected.map((s) => (
                <Badge key={s} tone="accent">{s}</Badge>
              ))}
            </div>
          )}
          <Field label={t("Published URL")} hint={t("For live scans (unlighthouse, strix).")}>
            <Input
              value={url}
              onChange={(e) => dispatch({ type: "patch", patch: { url: e.target.value } })}
              placeholder="https://myapp.example.com"
              autoFocus={focus === "url"}
              className="font-mono text-xs"
            />
          </Field>
          <Field
            label={t("Name")}
            hint={t("Defaults to the folder name — change it only if you want a different label.")}
          >
            <Input
              value={name}
              onChange={(e) => dispatch({ type: "patch", patch: { name: e.target.value } })}
              placeholder={t("auto from folder")}
            />
          </Field>
          <Field
            label={t("Tags")}
            hint={t("Your own labels, to find this project among many. Create one right here.")}
          >
            <TagPicker selected={tags} onChange={(ids) => dispatch({ type: "patch", patch: { tags: ids } })} />
          </Field>
          <SwitchField
            label={t("Authorized target")}
            hint={t("I own this target or am authorized to test it.")}
            checked={authorized}
            onCheckedChange={(v) => dispatch({ type: "patch", patch: { authorized: v } })}
          />
          {!project && path.trim() && (
            <SwitchField
              label={t("Publishes to a server")}
              hint={t("Set up where it uploads (SFTP or FTP) right after adding it.")}
              checked={deploys}
              onCheckedChange={setDeploys}
            />
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            {project ? t("Save") : t("Add project")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
