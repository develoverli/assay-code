import { defaultWindowIcon } from "@tauri-apps/api/app";
import { Menu } from "@tauri-apps/api/menu";
import { TrayIcon } from "@tauri-apps/api/tray";
import { tr } from "@/lib/i18n";

/** The system tray icon: closing the window only hides it, so the tray is the way back in and out. */

const TRAY_ID = "assay-tray";

export interface TrayHandlers {
  /** Bring the window back, or hide it if it is already up front. */
  onToggleWindow: () => void;
  /** Show the window and start the quit flow (which may ask about live runs). */
  onQuit: () => void;
}

let tray: TrayIcon | null = null;
/** In flight creation, so a double effect in dev never registers two icons. */
let creating: Promise<TrayIcon> | null = null;
let handlers: TrayHandlers | null = null;
let lastCount = -1;

const runLabel = (n: number) => {
  if (n === 0) return tr("Nothing in flight");
  if (n === 1) return tr("1 process in flight");
  return tr("{n} processes in flight", { n });
};

async function buildMenu(running: number): Promise<Menu> {
  return Menu.new({
    items: [
      { id: "show", text: tr("Show Assay"), action: () => handlers?.onToggleWindow() },
      { id: "runs", text: runLabel(running), enabled: false },
      { item: "Separator" },
      { id: "quit", text: tr("Quit Assay"), action: () => handlers?.onQuit() },
    ],
  });
}

/** Creates the tray once. Safe to call again: later calls only refresh the menu. */
export async function ensureTray(h: TrayHandlers, running: number): Promise<void> {
  handlers = h;
  if (tray) return updateTray(running);
  if (!creating) {
    creating = (async () =>
      TrayIcon.new({
        id: TRAY_ID,
        icon: (await defaultWindowIcon()) ?? undefined,
        tooltip: `Assay — ${runLabel(running)}`,
        menu: await buildMenu(running),
        // left click belongs to the window toggle; the menu is on right click
        showMenuOnLeftClick: false,
        action: (event) => {
          if (event.type === "Click" && event.button === "Left" && event.buttonState === "Up") {
            handlers?.onToggleWindow();
          }
        },
      }))();
  }
  tray = await creating;
  lastCount = running;
}

/** Keeps the menu line and the tooltip in step with what is actually running. */
async function updateTray(running: number): Promise<void> {
  if (!tray || running === lastCount) return;
  lastCount = running;
  await tray.setTooltip(`Assay — ${runLabel(running)}`);
  await tray.setMenu(await buildMenu(running));
}
