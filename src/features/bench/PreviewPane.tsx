import * as React from "react";
import { RotateCw } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { PinnedPreview } from "@/store/bench";
import { ImagePreview, PageFrame, PreviewActions, PreviewTitle } from "./LinkPreview";

/**
 * A pinned link preview, full size: the page live at its real width, or the
 * image fitted to the surface. Every pinned preview of the project stays
 * mounted, like the other surfaces, so switching tabs does not reload a page.
 */
function PinnedSurface({ preview }: { preview: PinnedPreview }) {
  const t = useT();
  const { target } = preview;
  // a key bump is a reload: the iframe is rebuilt with the same URL
  const [generation, setGeneration] = React.useState(0);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-soft bg-surface pl-3 pr-1">
        <div className="min-w-0 flex-1">
          <PreviewTitle target={target} />
        </div>
        {target.kind === "url" && (
          <button
            type="button"
            onClick={() => setGeneration((g) => g + 1)}
            aria-label={t("Reload")}
            title={t("Reload")}
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-2 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        )}
        <PreviewActions target={target} pinned />
      </div>
      <div className="min-h-0 flex-1">
        {target.kind === "url" ? (
          <PageFrame key={generation} url={target.url} scaled={false} />
        ) : (
          <ImagePreview path={target.path} name={target.name} fill />
        )}
      </div>
    </div>
  );
}

export function PreviewPane({ previews, active }: { previews: PinnedPreview[]; active: string | null }) {
  return (
    <>
      {previews.map((p) => (
        <div key={p.id} className={cn("absolute inset-0", p.id !== active && "invisible")}>
          <PinnedSurface preview={p} />
        </div>
      ))}
    </>
  );
}
