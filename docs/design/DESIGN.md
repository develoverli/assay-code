# Assay — Design

Dark-first, data-dense devtool. Reference points: Linear, Raycast, a good terminal.
Source of truth for tokens: `src/styles/globals.css` (`@theme`). This file describes how
to use them; it never restates a value the CSS doesn't already define.

## Color tokens

| Token | Hex | Use |
|---|---|---|
| `bg` | `#0a0b0d` | App background |
| `surface` | `#141619` | Cards, panels, sidebar, floating windows |
| `surface-2` | `#1b1e23` | Inputs, tabs, insets inside a surface |
| `surface-3` | `#22262c` | Hover on surface-2 |
| `border` | `#26292f` | Standard separator |
| `border-soft` | `#1f2227` | Separator inside a card |
| `text` | `#e6e8eb` | Primary text |
| `text-2` | `#9ba1a9` | Secondary text, labels |
| `text-3` | `#868d95` | Hints, metadata, disabled (meets AA on every surface) |
| `accent` | `#7c5cff` | Selection, active nav, primary action |
| `accent-soft` | `#211c3d` | Background of the accented state |
| `success` / `warn` / `danger` | `#3dd68c` / `#ffc53d` / `#ff4d4d` | Run outcomes |
| `crit` `high` `med` `low` `info` | red → orange → amber → blue → grey | Finding severity |

Rules:

- **Never a raw hex in a component.** Use the token.
- **Never color alone.** Severity and run status always pair the dot with a label or an
  `aria-label` (`SeverityPill`, `StatusBadge`, `StatusDot` already do this).
- `accent` marks *where you are* and *the one primary action*. One primary per screen.

## Typography

- `Inter` for UI, `JetBrains Mono` for commands, paths, logs and diffs.
- Body is 13px; the scale in use is 10 / 11 / 13 / 15px. Below 10px is not allowed.
- Numbers that change in place (timers, counts, metrics) get `.tnum` so the layout
  doesn't jitter.
- Log and path regions get `.selectable` — the rest of the app is `user-select: none`,
  because it's an app window, not a document.

## Layout

- Fixed sidebar (`w-56`) + content column. Content scrolls; chrome doesn't.
- Content is centred with a per-view `max-w-*` (`3xl` settings, `4xl` tools/processes,
  `6xl` findings).
- Spacing is a 4px rhythm: `gap-1.5 / 2.5 / 3 / 4`, padding `p-3 / p-3.5 / p-4 / p-5`.
- Radius: `md` for controls, `lg` for cards and floating windows.
- Persistent bars (the run dock) live **in the layout**, not floating: they must never
  cover content.

## Z-index scale

| Layer | z |
|---|---|
| Content | — |
| Run dock | in flow |
| Floating run window | 30 |
| Dialog overlay | 40 |
| Dialog / dropdown | 50 |

Anything new fits this scale; no ad-hoc values.

## Components

- **Card** — `rounded-lg border border-border bg-surface`. The default container.
- **Button** — variants `primary` (accent), `secondary`, `subtle`, `ghost`, `danger`;
  sizes `sm` and `icon`. Icon-only buttons **must** carry `aria-label` and `title`.
- **Badge** — tones `neutral / accent / success / warn / danger`, for metadata, never for
  actions.
- **Terminal** — monospace log surface, always scrolled to the tail.
- **ConfirmDialog** — required before anything destructive or outward-facing; it shows the
  exact command that will run.

## Interaction

- Every clickable element gets `cursor-pointer`.
- A disabled control must say **why** — `title` at minimum, inline text when there's room.
  "Disabled with no explanation" is a bug.
- Destructive actions use the `danger` variant and are separated from routine ones.
- Long-running work streams output; anything above ~300ms without output shows a spinner
  with a sentence saying what is being waited on.

## Motion

- 150–300ms, `animate-in` for entrances; `transform` and `opacity` only.
- Motion explains a relationship (a panel came from its tab, a dialog came from its
  trigger). Decorative animation is not used anywhere.
- Status pulse (`assay-pulse`) means exactly one thing: this is running right now.

## Anti-patterns

- Emoji as icons — use Lucide, one family, consistent stroke.
- A second primary button competing on the same screen.
- Grey-on-grey below AA. Every text token must clear 4.5:1 on the surface it sits on;
  `text-3` was raised from `#6b7178` (3.39:1) for exactly this reason.
- Floating panels that cover the content the user is working on.
- Reporting success when the recorded outcome says otherwise.
