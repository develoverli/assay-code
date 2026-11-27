import * as React from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Eye, EyeOff, ExternalLink, FolderOpen, Globe, Pin, SquareArrowOutUpRight } from "lucide-react";
import { readFile, stat } from "@tauri-apps/plugin-fs";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { groupsOf } from "@/lib/pane-layout";
import { usePanes } from "@/store/panes";
import { ASSAY_THEME, initMonaco } from "@/lib/monaco";
import { isSecretFile, languageOf, openFile } from "@/lib/fs-tree";
import { writeClipboard } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useBench } from "@/store/bench";
import { Spinner } from "@/components/ui/primitives";
import { fileGlyph } from "./icons";
import { isMedia, sliceAround, type MediaKind, type PreviewTarget } from "./link-detect";
import { closePreview, holdPreview, leaveLink, useLinkPreview } from "./link-preview-state";
import { activateTarget } from "./terminal-links";

/**
 * The preview of a terminal link, as a popover while the pointer rests on it.
 * Media (a picture, a video, a sound) is shown at once: it is what you came to
 * look at. Code and pages get a bar of actions instead — open here, open in the
 * browser, show in the folder, copy — and **Preview** renders them only when
 * asked, because loading a page (a dev server's whole app) every time the
 * pointer crosses a link is heavy and gets in the way. Media and pages can also
 * be pinned as a tab (`PreviewPane`).
 */

/** Lines of code shown around the one the link points at. */
const CODE_LINES = 15;
/** A page renders at a desktop width and is scaled into the popover, like a thumbnail you can use. */
const PAGE_WIDTH = 1280;
const PAGE_HEIGHT = 800;
const PAGE_SCALE = 0.5;
/** Room kept between the popover and the window edge, and between it and the pointer. */
const EDGE = 8;
const GAP = 14;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
};

/**
 * The webview plays media from a blob read into memory, so a file past this is
 * not loaded on a hover; the folder and the system player are one click away.
 */
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

/** A Windows path back in its own separators: Explorer's `/select` does not take forward slashes. */
const nativePath = (path: string): string => (/^[A-Za-z]:\//.test(path) ? path.replace(/\//g, "\\") : path);

/**
 * The sandbox a page gets. Scripts run, so a dev server's app works; it never
 * opens popups, navigates Assay or submits forms. `allow-same-origin` is dropped
 * when the page shares Assay's own origin (Assay's dev server under `tauri dev`),
 * since that pair would let the page lift its own sandbox.
 */
export function pageSandbox(url: string): string {
  let sameOrigin = false;
  try {
    sameOrigin = new URL(url).origin === window.location.origin;
  } catch {
    /* an unparseable URL gets the strict sandbox */
    sameOrigin = true;
  }
  return sameOrigin ? "allow-scripts" : "allow-scripts allow-same-origin";
}

/* ---------------------------------- code --------------------------------- */

type CodeState =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "secret" }
  | { status: "ready"; html: string[]; first: number; mark: number | null };

function useCodeSlice(path: string, name: string, line: number): CodeState {
  const [state, setState] = React.useState<CodeState>({ status: "loading" });
  React.useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    // a secrets file is opened on purpose, never shown because a pointer passed over it
    if (isSecretFile(name)) {
      setState({ status: "secret" });
      return;
    }
    void (async () => {
      const res = await openFile(path, name);
      if (cancelled) return;
      if (!res.ok) {
        setState({ status: "error", reason: res.reason });
        return;
      }
      const slice = sliceAround(res.content, line, CODE_LINES);
      const monaco = initMonaco();
      monaco.editor.setTheme(ASSAY_THEME);
      // colorize escapes the text itself; its lines come back joined by <br/>
      const html = await monaco.editor.colorize(slice.lines.join("\n"), languageOf(name), { tabSize: 2 });
      if (cancelled) return;
      setState({ status: "ready", html: html.split(/<br\s*\/?>/), first: slice.first, mark: slice.mark });
    })().catch((e: unknown) => {
      if (!cancelled) setState({ status: "error", reason: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      cancelled = true;
    };
  }, [path, name, line]);
  return state;
}

function CodePreview({ path, name, line }: { path: string; name: string; line: number }) {
  const t = useT();
  const state = useCodeSlice(path, name, line);
  if (state.status === "loading") return <PreviewMessage busy text={t("Reading the file…")} />;
  if (state.status === "secret") {
    return <PreviewMessage text={t("Secrets file, not previewed on hover. Ctrl+click opens it read-only.")} />;
  }
  if (state.status === "error") return <PreviewMessage text={state.reason} />;
  return (
    <div className="selectable max-h-[320px] overflow-auto py-1.5 font-mono text-[11px] leading-[1.55]">
      {state.html.map((row, i) => {
        const marked = state.mark === i;
        return (
          <div key={state.first + i} className={cn("flex pr-3", marked && "bg-accent-soft")}>
            <span
              className={cn(
                "tnum w-10 shrink-0 select-none pr-3 text-right",
                marked ? "text-accent" : "text-text-3",
              )}
            >
              {state.first + i}
            </span>
            {/* monaco's own escaped, tokenised markup */}
            <span className="whitespace-pre" dangerouslySetInnerHTML={{ __html: row || " " }} />
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------- image -------------------------------- */

export function ImagePreview({ path, name, fill = false }: { path: string; name: string; fill?: boolean }) {
  const t = useT();
  const [src, setSrc] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [size, setSize] = React.useState<{ w: number; h: number; bytes: number } | null>(null);

  React.useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setSrc(null);
    setError(null);
    void readFile(path)
      .then((bytes) => {
        if (cancelled) return;
        const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
        url = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] ?? "application/octet-stream" }));
        setSrc(url);
        setSize((s) => ({ w: s?.w ?? 0, h: s?.h ?? 0, bytes: bytes.byteLength }));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, name]);

  if (error) return <PreviewMessage text={error} />;
  if (!src) return <PreviewMessage busy text={t("Reading the image…")} />;
  return (
    <div className={cn("flex flex-col", fill && "h-full")}>
      <div className={cn("flex min-h-0 bg-surface-2 items-center justify-center", fill ? "flex-1 p-4" : "p-3")}>
        <img
          src={src}
          alt={name}
          onLoad={(e) => {
            const img = e.currentTarget;
            setSize((s) => ({ w: img.naturalWidth, h: img.naturalHeight, bytes: s?.bytes ?? 0 }));
          }}
          className={cn("object-contain", fill ? "max-h-full max-w-full" : "max-h-[300px] max-w-[440px]")}
        />
      </div>
      {size && size.w > 0 && (
        <p className="tnum border-t border-border-soft px-3 py-1.5 font-mono text-[10px] text-text-3">
          {size.w} × {size.h} · {(size.bytes / 1024).toFixed(1)} KB
        </p>
      )}
    </div>
  );
}

/** A video or a sound from disk, with the player's own controls. Nothing plays until asked. */
function PlayablePreview({ kind, path, name, fill }: { kind: "video" | "audio"; path: string; name: string; fill: boolean }) {
  const t = useT();
  const [src, setSrc] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setSrc(null);
    setError(null);
    void (async () => {
      const info = await stat(path);
      if (info.size > MAX_MEDIA_BYTES) {
        throw new Error(t("Too large to play here ({size} MB). Show it in the folder to open it with your player.", {
          size: Math.round(info.size / 1024 / 1024),
        }));
      }
      const bytes = await readFile(path);
      if (cancelled) return;
      const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      url = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] ?? "application/octet-stream" }));
      setSrc(url);
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, name, t]);

  if (error) return <PreviewMessage text={error} />;
  if (!src) return <PreviewMessage busy text={kind === "video" ? t("Reading the video…") : t("Reading the audio…")} />;
  if (kind === "audio") {
    return (
      <div className={cn("flex items-center justify-center bg-surface-2 p-3", fill && "h-full")}>
        <audio src={src} controls preload="metadata" className="w-[min(420px,100%)]" />
      </div>
    );
  }
  return (
    <div className={cn("flex items-center justify-center bg-surface-2", fill ? "h-full p-4" : "p-2")}>
      <video
        src={src}
        controls
        preload="metadata"
        className={cn("object-contain", fill ? "max-h-full max-w-full" : "max-h-[300px] max-w-[480px]")}
      />
    </div>
  );
}

/** Whichever media the target is, at popover size or filling a pinned tab. */
export function MediaPreview({ kind, path, name, fill = false }: { kind: MediaKind; path: string; name: string; fill?: boolean }) {
  if (kind === "image") return <ImagePreview path={path} name={name} fill={fill} />;
  return <PlayablePreview kind={kind} path={path} name={name} fill={fill} />;
}

/* ---------------------------------- page --------------------------------- */

export function PageFrame({ url, scaled }: { url: string; scaled: boolean }) {
  const t = useT();
  const sandbox = pageSandbox(url);
  if (!scaled) {
    return (
      <iframe
        src={url}
        title={url}
        sandbox={sandbox}
        referrerPolicy="no-referrer"
        className="h-full w-full border-0"
      />
    );
  }
  return (
    <div>
      <div style={{ width: PAGE_WIDTH * PAGE_SCALE, height: PAGE_HEIGHT * PAGE_SCALE }} className="overflow-hidden">
        <iframe
          src={url}
          title={url}
          sandbox={sandbox}
          referrerPolicy="no-referrer"
          style={{
            width: PAGE_WIDTH,
            height: PAGE_HEIGHT,
            transform: `scale(${PAGE_SCALE})`,
            transformOrigin: "0 0",
          }}
          className="border-0"
        />
      </div>
      <p className="border-t border-border-soft px-3 py-1.5 text-[10px] text-text-3">
        {t("A blank page usually means the site refuses to be embedded. Open it in the browser.")}
      </p>
    </div>
  );
}

/* --------------------------------- shared -------------------------------- */

function PreviewMessage({ text, busy = false }: { text: string; busy?: boolean }) {
  return (
    <div className="flex min-h-[64px] items-center gap-2 px-3 py-4 text-[12px] text-text-2">
      {busy && <Spinner className="h-3.5 w-3.5" />}
      <span className="selectable">{text}</span>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-2 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}

/** Copy, reveal, pin and open — the same for the popover and the pinned tab. */
export function PreviewActions({ target, pinned = false }: { target: PreviewTarget; pinned?: boolean }) {
  const t = useT();
  const [copied, setCopied] = React.useState(false);
  const setError = useBench((s) => s.setError);
  const openPreview = useBench((s) => s.openPreview);

  const text = target.kind === "url" ? target.url : target.kind === "code" && target.line ? `${target.path}:${target.line}` : target.path;
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <ActionButton
        label={copied ? t("Copied") : target.kind === "url" ? t("Copy URL") : t("Copy path")}
        onClick={() => void writeClipboard(text).then(() => setCopied(true), fail)}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </ActionButton>
      {target.kind !== "url" && (
        <ActionButton
          label={t("Reveal in folder")}
          onClick={() => void revealItemInDir(nativePath(target.path)).catch(fail)}
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </ActionButton>
      )}
      {!pinned && target.kind !== "code" && (
        <ActionButton
          label={t("Pin as a tab")}
          onClick={() => {
            closePreview();
            openPreview(target);
          }}
        >
          <Pin className="h-3.5 w-3.5" />
        </ActionButton>
      )}
      {(pinned ? target.kind === "url" : true) && (
        <ActionButton
          label={target.kind === "url" ? t("Open in browser") : isMedia(target) ? t("Open as a tab") : t("Open in editor")}
          onClick={() => {
            closePreview();
            void activateTarget(target).catch(fail);
          }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </ActionButton>
      )}
    </div>
  );
}

/** Icon and label of a target, as a header line. */
export function PreviewTitle({ target }: { target: PreviewTarget }) {
  if (target.kind === "url") {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <Globe className={cn("h-3.5 w-3.5 shrink-0", target.local ? "text-success" : "text-low")} />
        <span className="selectable truncate font-mono text-[11px] text-text" title={target.url}>
          {target.url}
        </span>
      </span>
    );
  }
  const { Icon, tone } = fileGlyph(target.name);
  const line = target.kind === "code" && target.line ? `:${target.line}` : "";
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon className={cn("h-3.5 w-3.5 shrink-0", tone)} />
      <span className="truncate text-[12px] font-medium text-text">{target.name}</span>
      <span className="selectable truncate font-mono text-[10px] text-text-3" title={target.path}>
        {target.path}
        {line}
      </span>
    </span>
  );
}

export function PreviewBody({ target }: { target: PreviewTarget }) {
  if (target.kind === "code") return <CodePreview path={target.path} name={target.name} line={target.line} />;
  if (isMedia(target)) return <MediaPreview kind={target.kind} path={target.path} name={target.name} />;
  return <PageFrame url={target.url} scaled />;
}

/** A labelled button in the hover bar: words, not only an icon, since this is where you decide. */
function BarButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={cn(
        "flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors",
        "focus-visible:outline-2 focus-visible:outline-accent",
        pressed ? "bg-accent-soft text-accent" : "text-text-2 hover:bg-surface-2 hover:text-text",
      )}
    >
      {children}
      {label}
    </button>
  );
}

/**
 * What the popover offers for any link: open it here (the editor at the line, or
 * a pinned tab for a page or media), Preview for code and pages, the browser for
 * a URL, the folder for a file, and copy.
 */
function HoverBar({
  target,
  expanded,
  onToggle,
}: {
  target: PreviewTarget;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const setError = useBench((s) => s.setError);
  const openPreview = useBench((s) => s.openPreview);
  const [copied, setCopied] = React.useState(false);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const text = target.kind === "url" ? target.url : target.kind === "code" && target.line ? `${target.path}:${target.line}` : target.path;

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  const openHere = () => {
    closePreview();
    if (target.kind === "code") void activateTarget(target).catch(fail);
    else openPreview(target);
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5 px-1 py-1">
      <BarButton label={t("Open here")} onClick={openHere}>
        <SquareArrowOutUpRight className="h-3.5 w-3.5" />
      </BarButton>
      {!isMedia(target) && (
        <BarButton label={expanded ? t("Hide preview") : t("Preview")} onClick={onToggle} pressed={expanded}>
          {expanded ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </BarButton>
      )}
      {target.kind === "url" ? (
        <BarButton
          label={t("Open in browser")}
          onClick={() => {
            closePreview();
            void openUrl(target.url).catch(fail);
          }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </BarButton>
      ) : (
        <BarButton label={t("Show in folder")} onClick={() => void revealItemInDir(nativePath(target.path)).catch(fail)}>
          <FolderOpen className="h-3.5 w-3.5" />
        </BarButton>
      )}
      <ActionButton
        label={copied ? t("Copied") : target.kind === "url" ? t("Copy URL") : t("Copy path")}
        onClick={() => void writeClipboard(text).then(() => setCopied(true), fail)}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </ActionButton>
      <span role="status" aria-atomic="true" className="sr-only">
        {copied ? t("Copied") : ""}
      </span>
    </div>
  );
}

/* --------------------------------- popover ------------------------------- */

/** Where the popover goes: under the pointer, above it when there is no room, always inside the window. */
function place(anchor: { x: number; y: number }, w: number, h: number): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(EDGE, anchor.x - w / 3), vw - w - EDGE);
  const below = anchor.y + GAP;
  const top = below + h <= vh - EDGE ? below : Math.max(EDGE, anchor.y - GAP - h);
  return { left: Math.max(EDGE, left), top };
}

/** The hover popover; mounted once, it shows whatever the link providers last asked for. */
export function LinkPreviewPopover() {
  const t = useT();
  const target = useLinkPreview((s) => s.target);
  const anchor = useLinkPreview((s) => s.anchor);
  const sessionId = useLinkPreview((s) => s.sessionId);
  const projectId = useBench((s) => s.projectId);
  // the terminal that printed the link is on screen while it is the front tab of some pane
  const onScreen = usePanes((s) => {
    const layout = s.layouts[projectId ?? ""];
    return !!sessionId && !!layout && groupsOf(layout).some((g) => g.front === `t:${sessionId}`);
  });
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  /** Code and pages render only once asked for; a new link starts folded again. */
  const [expanded, setExpanded] = React.useState(false);
  const id = target ? (target.kind === "url" ? target.url : target.path) : null;

  React.useEffect(() => setExpanded(false), [id]);

  // another tab in front of that pane means the link it was about is gone from view
  React.useEffect(() => {
    if (sessionId && !onScreen) closePreview();
  }, [sessionId, onScreen]);

  React.useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePreview();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [target]);

  // measured after layout and again as content arrives (an image, the colourised code)
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) {
      setPos(null);
      return;
    }
    const update = () => setPos(place(anchor, el.offsetWidth, el.offsetHeight));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [anchor, target, expanded]);

  if (!target || !anchor) return null;
  const media = isMedia(target);
  const showBody = media || expanded;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t("Link preview")}
      onPointerEnter={holdPreview}
      onPointerLeave={(e) => {
        // entering the page's iframe reads as leaving in some webviews; the pointer is still here
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom) return;
        leaveLink();
      }}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      className={cn(
        "fixed z-50 flex max-w-[min(680px,calc(100vw-16px))] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl",
        target.kind === "code" && expanded ? "w-[560px]" : "w-max",
        pos && "animate-in",
      )}
    >
      <div className="max-w-full border-b border-border-soft px-3 pt-2 pb-0.5">
        <PreviewTitle target={target} />
      </div>
      <HoverBar target={target} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      {showBody && (
        <div className="min-h-0 border-t border-border-soft">
          <PreviewBody key={`${target.kind}:${id ?? ""}`} target={target} />
        </div>
      )}
      <p className="border-t border-border-soft px-3 py-1 text-[10px] text-text-3">
        {t("Ctrl+click the link to open it · Esc closes")}
      </p>
    </div>,
    document.body,
  );
}
