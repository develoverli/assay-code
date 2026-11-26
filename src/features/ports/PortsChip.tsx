import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Globe, Square } from "lucide-react";
import * as React from "react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "@/lib/i18n";
import { linkHost } from "@/lib/ports";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useBench } from "@/store/bench";
import { activeTunnels, usePorts } from "@/store/ports";

/** Live links a project holds — a number, so a log line elsewhere does not re-render the rail. */
export function useTunnelCount(projectId: string): number {
  return usePorts((s) => activeTunnels(s.tunnels).filter((t) => t.projectId === projectId).length);
}

/**
 * Footer chip: this project's public links, in `warn` because something on this
 * machine is reachable from the internet while it shows. Absent when there are none.
 */
export function PortsChip({ projectId }: { projectId: string }) {
  const t = useT();
  const openDock = useBench((s) => s.openDock);
  const count = useTunnelCount(projectId);
  if (!count) return null;
  return (
    <button
      type="button"
      onClick={() => openDock("ports")}
      title={t("Open Ports")}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 text-warn hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Globe className="h-3 w-3 shrink-0" />
      <span className="tnum">{count === 1 ? t("1 public link") : t("{n} public links", { n: count })}</span>
    </button>
  );
}

/**
 * Links held by other projects: they keep running across a project switch the
 * way terminals do, so they are listed here with a way back and a way to close them.
 */
export function TunnelsElsewhere({ projectId }: { projectId: string }) {
  const t = useT();
  const projects = useApp((s) => s.projects);
  const setActiveProject = useApp((s) => s.setActiveProject);
  const setProject = useBench((s) => s.setProject);
  const openDock = useBench((s) => s.openDock);
  const stop = usePorts((s) => s.stop);
  const others = usePorts(
    useShallow((s) => activeTunnels(s.tunnels).filter((tun) => tun.projectId !== projectId)),
  );
  if (!others.length) return null;

  const item = "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] outline-none transition-colors";

  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          className="tnum flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 text-warn transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
          title={t("Public links held by other projects")}
        >
          <Globe className="h-3 w-3 shrink-0" />
          {others.length === 1 ? t("1 link in another project") : t("{n} links in other projects", { n: others.length })}
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="end"
          side="top"
          sideOffset={6}
          className="z-50 min-w-[240px] rounded-lg border border-border bg-surface p-1.5 shadow-2xl animate-in"
        >
          {others.map((tun, i) => {
            const owner = projects.find((p) => p.id === tun.projectId);
            return (
              <React.Fragment key={tun.id}>
                {i > 0 && <Dropdown.Separator className="my-1 h-px bg-border-soft" />}
                {owner && (
                  <Dropdown.Item
                    className={cn(item, "text-text-2 data-[highlighted]:bg-surface-2 data-[highlighted]:text-text")}
                    onSelect={() => {
                      setActiveProject(owner.id);
                      setProject(owner.id, owner.path ?? null);
                      openDock("ports");
                    }}
                  >
                    <Globe className="h-3.5 w-3.5 shrink-0 text-warn" />
                    <span className="min-w-0 flex-1 truncate">
                      {owner.name} <span className="tnum font-mono text-text-3">:{tun.port}</span>
                    </span>
                    {tun.url && (
                      <span className="max-w-[140px] truncate font-mono text-[10px] text-text-3">{linkHost(tun.url)}</span>
                    )}
                  </Dropdown.Item>
                )}
                <Dropdown.Item
                  className={cn(item, "text-text-3 data-[highlighted]:bg-surface-2 data-[highlighted]:text-text")}
                  onSelect={() => void stop(tun.id).catch(() => undefined)}
                >
                  <Square className="h-3 w-3 shrink-0" />
                  {t("Stop the link to :{port}", { port: tun.port })}
                </Dropdown.Item>
              </React.Fragment>
            );
          })}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
