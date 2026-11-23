import { CloudAlert, CloudCheck, CloudUpload } from "lucide-react";
import * as React from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useBench } from "@/store/bench";
import { useDeploy } from "@/store/deploy";
import type { Project } from "@/types";
import { useDeployBadge, useLoadAndScan } from "./DeployPanel";

/**
 * Footer chip for Deploy: pending count, upload in flight, or last failure.
 * Renders nothing without a server. Mounting it also loads the servers, scans
 * once and syncs the watchers, so the count stays true while the panel is closed.
 */
export function DeployChip({ project }: { project: Project }) {
  const t = useT();
  const openDock = useBench((s) => s.openDock);
  const syncWatchers = useDeploy((s) => s.syncWatchers);
  const projects = useApp((s) => s.projects);
  const badge = useDeployBadge(project.id);

  // shared with the panel, which mounts at the same time: one scan between the two
  useLoadAndScan(project);

  React.useEffect(() => {
    void syncWatchers(projects, project.id);
  }, [badge.servers, project.id, projects, syncWatchers]);

  if (!badge.servers) return null;

  let Icon = CloudCheck;
  let label = t("Deployed");
  let tone = "";
  if (badge.uploading) {
    Icon = CloudUpload;
    label = t("Uploading…");
    tone = "text-accent";
  } else if (badge.failed) {
    Icon = CloudAlert;
    label = t("Deploy failed");
    tone = "text-danger";
  } else if (badge.pending > 0) {
    Icon = CloudUpload;
    label = badge.pending === 1 ? t("1 to upload") : t("{n} to upload", { n: badge.pending });
  }

  return (
    <button
      type="button"
      onClick={() => openDock("deploy")}
      title={t("Open Deploy")}
      className={cn(
        "flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent",
        tone,
      )}
    >
      <Icon className={cn("h-3 w-3 shrink-0", badge.uploading && "animate-pulse")} />
      <span className="tnum">{label}</span>
    </button>
  );
}
