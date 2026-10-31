# Styling: Tailwind prefixes, ui-kit tokens, Akros, design rules

## 1. Which class syntax to write

OntOS is a Modern.js shell with Module Federation remotes. There are two Tailwind builds:

| Build | Where | Syntax |
|---|---|---|
| Shell ui-kit build (unprefixed) | `app/apps/shell-super-app/src/routes/ui-kit.css`: `@import '@techsio/ui-kit/tokens-with-tailwind'` + `@source` of ui-kit dist, `packages/admin-ui`, `verticals/*/src` | `gap-200 p-250 bg-surface text-fg-secondary border-border-primary` |
| Vertical build (prefixed) | `app/verticals/<v>/src/routes/index.css`: `@import 'tailwindcss' prefix(<prefix>) source(none)` | `worktasks:flex worktasks:gap-4` |

Before writing classes, run:
`grep -n '@source' app/apps/shell-super-app/src/routes/ui-kit.css`

- If it lists `verticals`, write unprefixed ui-kit token classes in vertical TSX, as the Akros
  pages do. This is the default after plan 03.
- If it does not, write prefixed classes with the standard scale, and colours as CSS variables:
  `<prefix>:gap-3 <prefix>:text-(--color-fg-secondary) <prefix>:bg-(--color-surface)`.
- Never mix both syntaxes for the same CSS property on one element.
- Always verify through the shell URL. A remote opened standalone has no ui-kit styles.
- The vertical prefix is the package name without dashes. Copy it from the vertical's `index.css`
  (e.g. `worktasks`, `salespipeline`).

Most of the time you write almost no classes. ui-kit components and `@app/admin-ui` helpers
style themselves. Use classes only for page layout (grid/flex/gap) and secondary text.

## 2. ui-kit token cheat sheet (unprefixed)

Spacing (fluid): `50`≈2px, `100`≈5px, `150`≈10px, `200`≈14px, `250`≈20px, `300`≈24px, `350`≈28px, `450`≈38px.
Dense admin uses `gap-100`/`gap-150` inside cells and cards, `gap-200` between controls, and `gap-250`
between page sections (AdminShell `<main>` already uses `gap-250 p-250`).

Text: `text-xs` (secondary meta lines only), `text-sm` (default body in admin), `text-md` (section
titles), `text-xl` (page title, set by PageHeader).

Colour roles (never raw palette like `bg-yellow-400`):

| Role | Class |
|---|---|
| Page background / card surface | `bg-base` / `bg-surface` |
| Recessed well / selection bar | `bg-overlay` |
| Primary / secondary text | `text-fg-primary` / `text-fg-secondary` |
| Border | `border-border-primary` |
| Accent text for alerts | `text-fg-accent-danger`, `text-fg-accent-warning`, `text-fg-accent-success`, `text-info` |

Layout widths: sidebar `w-3xs`, prose `max-w-prose`, icon box `size-icon-control-lg`.
Icons are Iconify MDI classes passed to ui-kit props: `icon="icon-[mdi--plus]"`.

## 3. Akros theme facts

- Activated by `<html data-theme="akros" class="light">` (shell, plan 03). Light only, so do not add `dark:` classes.
- Primary = Akros yellow (`oklch(0.851 0.163 86)`). A `variant="primary"` Button is yellow with black
  text. Because of that, only ONE primary per surface: the page action, or the drawer submit.
- Secondary = green, tertiary = blue (`tertiary-600` also drives `info`), danger = red, text = black,
  secondary text = `neutral-600`, borders = `neutral-300`.
- Chart series start from `--color-chart-series-1` (resolves through `--color-blue-500` → Akros blue).
  Do not override series colours. Do not put status colours into series.
- Akros visual reference pages (new-engine `libs/ui/stories/pages/akros/`): `dashboard` (alerts first,
  KPI row, tabbed chart, donut + bar-horizontal, latest table), `orders` (saved-view Tabs with counts,
  BulkActionBar, pinned first column, `tableLayout="fixed"`), `order-detail` (header with status
  badges in `meta`, `grid xl:grid-cols-3`, SectionCard + DetailList side column), `customers`
  (B2B form in Dialog with IČO validation).

## 4. Button vocabulary

| Use | Props |
|---|---|
| Page primary (one) | `variant="primary" size="sm" icon="icon-[mdi--plus]"` |
| Page secondary (Export, Více) | `variant="secondary" theme="outlined" size="sm"` |
| Section link-ish action | `variant="secondary" theme="borderless" size="sm"` |
| Drawer footer | `[Zrušit: variant="secondary" theme="outlined"] [Primary: variant="primary"]`, primary last |
| Destructive | `variant="danger"`, only in alertdialog footer or as the last row action (`tone: 'danger'`) |
| Busy | `isLoading loadingText="Ukládám…"` on the button that started the request |

## 5. ui:design rules folded in (and where ui-kit wins)

Applied as-is:
- Table headings: sentence case, never uppercase, never wrap (keep headers short; set `meta.width`).
- `tabular-nums` on every number that is compared or changes (money, counts, KPI values, quantities).
- Headings use `font-semibold`, never `font-bold`. No `leading-*` on headings. No emojis anywhere.
- Full sentences end with a period. Labels, buttons and column headers do not.
- Description lists: term `text-fg-secondary text-xs`, value `text-sm`. Matches `DetailList`.
- `hover:` only on interactive elements. No `transition-*` for colour changes.
- Spacing between siblings with `gap-*` on the parent, never `mt-*`/`mb-*`.
- `min-h-dvh` instead of `min-h-screen`. `size-*` instead of `h-* w-*` when equal.
- Never default to indigo or `gray-*`/`slate-*`. Use ui-kit colour roles only.
- Mobile: navigation collapses into a drawer below `lg` (shell does this). Multi-column layouts
  collapse to one column (`grid-cols-1 xl:grid-cols-3`). Horizontal tab bars scroll, never overflow.
- Lightest separation first: whitespace → border → card. Do not wrap every block in a card.

Deliberate deviations (ui-kit / Akros wins):
- "Never put tables in cards": a `DataTable` already draws its own rounded bordered frame. Put it
  directly in the page column. Do NOT wrap a DataTable in `SectionCard`, which would draw a double
  border. Use `SectionCard flush` only around a small static `Table` with a title (dashboard
  "Poslední faktury", invoice lines on a detail page).
- "No icons in stat cards": follow it. Do not pass `icon` to `StatCard`. Keep labels ≤ 22
  characters so they never wrap.
- "text-xs never for body": admin cells may use a `text-xs text-fg-secondary` secondary line under the
  primary value (email under customer name, date under invoice number). Never use it for primary content.
- "Container queries for dashboard widgets": skip. Use `StatRow` (flex-wrap) and
  `grid grid-cols-1 xl:grid-cols-2`, as Akros does.
- Native-input styling rules (checkbox/radio/select recipes) do not apply. Always use the ui-kit
  components, which carry their own tokens.
