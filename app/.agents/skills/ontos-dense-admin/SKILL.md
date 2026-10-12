---
name: ontos-dense-admin
description: >
  The rulebook for every OntOS admin screen (sales demo: customers, opportunities, invoices, tasks,
  products/stock, employees, tags, Statistiky). Use before writing or changing any vertical page,
  drawer, table, detail view or dashboard. Covers page anatomy, @techsio/ui-kit 0.56.0 +
  @app/admin-ui component choice, Akros theme and Tailwind prefixes, Czech copy and cs-CZ Intl
  formatting, status → Badge mapping, density, empty/loading/error states and the visual
  verification checklist.
---

# OntOS dense admin

You build dense, calm, Czech-first back-office screens with the Akros theme. The visual reference is the
Akros admin in new-engine (`libs/ui/stories/pages/akros/*`). Do not invent widgets. Compose ui-kit
components plus the `@app/admin-ui` helpers.

## Load order

1. This file (all of it).
2. `references/recipes.md`: copy the recipe that matches your page (A list, B create drawer, C detail, D KPI + chart).
3. `references/status-vocabulary.md` if the page shows any status, and `references/czech-copy-and-formatting.md`
   for formatters, DataTable translations and Czech wording.
4. `references/styling-tokens-and-design-rules.md` before writing any `className`.
5. The `techsio-ui-kit/<component>-usage/SKILL.md` for every kit component you use (index below).
6. Uncertain between ≥2 credible layouts? Follow `../ontos-ui-decision/SKILL.md`. Do not ask a human.

## Non-negotiables

1. **Only kit + admin-ui.** No raw `<table>`, `<button>`, `<select>`, `<input>`, hand-made badges, inline colours or new CSS files.
2. **Czech with full diacritics** (`Příležitost`, not `Prilezitost`) through `t()` and `locales/cs` + `locales/en`.
3. **Intl only.** `cs-CZ`, CZK, money stored in minor units. No raw ISO dates, no `toFixed`, no `"Kč"` concatenation. Missing value is `—`.
4. **Numbers end-aligned with `tabular-nums`.** Text, identifiers, dates and badges are start-aligned.
5. **One primary action per surface**: the page header (top-right) or the drawer footer (bottom-right, last).
6. **Every list and async block has loading, empty and error states.** A failed load never reads "no records".
7. **Status = Badge from the map** in `status-vocabulary.md`. Never pick a colour per screen.
8. **No dead UI.** Every visible button works against the real command. Do not add Export, Import or Settings unless implemented.
9. **Mutations confirm** with a toast `<Objekt> <příčestí>` (`Faktura vytvořena`). Validation stays on the field, never in a toast.
10. **Send `expectedRevision`** with every command. On conflict, show the inline StatusText error and offer a reload.

## Page anatomy

```text
Shell (plan 03): Akros sidebar + topbar, <main class="gap-250 p-250">, one <Toaster/>
└─ Vertical page
   ├─ PageHeader       breadcrumb? · title · description (1 sentence) · meta (status badges) · actions (primary last)
   ├─ Alerts?          StatusText / SectionCard "Vyžaduje pozornost" (only when something must be done today)
   ├─ StatRow?         3–4 StatCard (no icons), only on overview/statistics pages
   ├─ Tabs?            saved views with count badges (Moje, Bez obchodníka, Po splatnosti)
   ├─ BulkActionBar    only while rows are selected, above the table
   ├─ DataTable        size="sm", stickyHeader, pinned first column, pagination 50, directly on the page (no card)
   └─ Dialog placement="right"   create / edit / quick view; alertdialog for destructive confirmations
Detail page: PageHeader(meta badges) → problem notice → grid xl:grid-cols-3 (main span-2: SectionCards; side: DetailList cards)
```

## Component index: need → read this skill

Paths are relative to `app/.agents/skills/`. Read the file before you use the component.

| Need | Component (import path `@techsio/ui-kit/…`) | Skill |
|---|---|---|
| House UX rules (writing, states, actions, feedback) | — | `techsio-ui-kit/ux-guidelines/SKILL.md` (+ `references/*.md`) |
| Which component for an intent | — | `techsio-ui-kit/component-usage-ux/SKILL.md`, `techsio-ui-kit/ux-guidelines/references/component-selection.md` |
| List with search/filter/sort/select/paging | `organisms/data-table` | `techsio-ui-kit/data-table-usage/SKILL.md` |
| Small static table (invoice lines, latest 5) | `organisms/table` | `techsio-ui-kit/table-usage/SKILL.md` |
| Trend / comparison / share chart | `molecules/chart` | `techsio-ui-kit/chart-usage/SKILL.md` |
| Create / edit / quick-view drawer, confirmations | `molecules/dialog` (`placement="right"`, `role="alertdialog"`) | `techsio-ui-kit/dialog-usage/SKILL.md` |
| Mobile-only edge panel (filters) | `molecules/drawer` | `techsio-ui-kit/drawer-usage/SKILL.md` |
| Status / tag chip | `atoms/badge` | `techsio-ui-kit/badge-usage/SKILL.md` |
| Inline message with icon (error, warning) | `atoms/status-text` | `techsio-ui-kit/status-text-usage/SKILL.md` |
| Buttons, icon buttons | `atoms/button`, `atoms/action-icon` | `techsio-ui-kit/button-usage/SKILL.md`, `techsio-ui-kit/action-icon-usage/SKILL.md` |
| Text field with label + error | `molecules/form-input` | `techsio-ui-kit/form-input-usage/SKILL.md` |
| Money / quantity field | `molecules/form-numeric-input` + `atoms/numeric-input` | `techsio-ui-kit/form-numeric-input-usage/SKILL.md` |
| Multi-line note | `molecules/form-textarea` | `techsio-ui-kit/form-textarea-usage/SKILL.md` |
| Short fixed list (stage, priority, period) | `templates/select` (`SelectTemplate`) | `techsio-ui-kit/select-usage/SKILL.md` |
| Searchable pick (customer, employee, product, tags multi) | `molecules/combobox` | `techsio-ui-kit/combobox-usage/SKILL.md` |
| Date range (Statistiky) | `molecules/date-picker` (`selectionMode="range"`, `locale="cs-CZ"`) | `techsio-ui-kit/date-picker-usage/SKILL.md` |
| Boolean setting / permission toggle | `molecules/switch`, `molecules/form-checkbox` | `techsio-ui-kit/switch-usage/SKILL.md`, `techsio-ui-kit/form-checkbox-usage/SKILL.md` |
| Saved views / chart measure switch | `molecules/tabs` | `techsio-ui-kit/tabs-usage/SKILL.md` |
| Success / failure feedback | `molecules/toast` (`useToast`) | `techsio-ui-kit/toast-usage/SKILL.md` |
| Loading placeholders | `atoms/skeleton` | `techsio-ui-kit/skeleton-usage/SKILL.md` |
| Row "more" menu, header overflow | `molecules/menu` | `techsio-ui-kit/menu-usage/SKILL.md` |
| Hint on hover (truncated tags) | `atoms/tooltip` | `techsio-ui-kit/tooltip-usage/SKILL.md` |
| Side filter panel (if picked by decision) | `templates/facet-filter-panel` | `techsio-ui-kit/facet-filter-panel-usage/SKILL.md` |
| Kanban-like progress / wizard | `molecules/steps` | `techsio-ui-kit/steps-usage/SKILL.md` |
| Breadcrumb (inside PageHeader) | `templates/breadcrumb` | `techsio-ui-kit/breadcrumb-usage/SKILL.md` |
| Shell nav (plan 03 only) | `organisms/sidebar`, `molecules/tree-view` | `techsio-ui-kit/sidebar-usage/SKILL.md`, `techsio-ui-kit/tree-view-usage/SKILL.md` |
| Token / theme questions | — | `techsio-ui-kit/app-token-overrides/SKILL.md`, `techsio-ui-kit/tailwind-token-authoring/SKILL.md` |

## `@app/admin-ui` helpers (app/packages/admin-ui; check its `package.json` name and props)

| Helper | Use |
|---|---|
| `PageHeader` | One per page: `title`, `description`, `breadcrumb`, `meta` (badges), `actions` (primary last) |
| `SectionCard` | Titled block on detail/dashboard pages. Use `flush` around a static `Table`. Never around a `DataTable` |
| `StatCard` / `StatRow` | KPI tiles: `label`, `value` (formatted), `delta`, `trend`, `hint`. Do not pass `icon` |
| `BulkActionBar` | `count`, `onClear`, children = bulk actions (primary first, destructive last). Renders nothing at 0 |
| `EmptyState` | `title` (sentence with a period), `description`, one `action`. Used for empty, no-results and error |
| `DetailList` | Read-only term/value grid in detail pages and quick-view drawers |
| `StatusBadge` / `TagBadge` | Status chips (variants per `status-vocabulary.md`) and tag chips |

If a helper still renders English text (e.g. `N selected`), do not fork it. Report the gap to the orchestrator
(plan 03 owns admin-ui).

## Density rules

- DataTable: `size="sm"`, `stickyHeader` + `maxHeight="calc(100dvh - 15rem)"`, `tableLayout="fixed"`, numeric
  `meta.width` on every column, first column pinned, `pageSizeOptions={[50, 100, 200]}` (the first entry is the default).
- Two-line cells instead of more columns: primary value + `text-xs text-fg-secondary` secondary line (customer under
  opportunity, e-mail under name, date under number).
- At most 7 visible columns at 1440px. Put the rest in the detail drawer.
- Spacing: `gap-50`/`gap-100` inside cells, `gap-150`/`gap-200` inside cards and forms, `gap-250` between sections.
- Buttons `size="sm"` in headers, bulk bars and tables. Drawer footers use the default size.
- No decorative illustrations, hero banners, gradients, shadows or icons in KPI tiles.

## States

| State | Render |
|---|---|
| Loading list | `DataTable loading` (skeleton rows, header stays) |
| Loading card/chart | `<Skeleton isLoaded={false}><Skeleton.Rectangle /></Skeleton>` of the final size |
| Refreshing | Keep rows. Never blank the table |
| Empty (first use) | `EmptyState` "Zatím tu nejsou žádné …" + create action |
| No results | `EmptyState` "Filtrům neodpovídá …" + `Zrušit filtry` |
| Error | `EmptyState` "Data se nepodařilo načíst." + `Zkusit znovu` |
| Forbidden (role lacks permission) | `EmptyState` "K této sekci nemáte oprávnění." Hide the write actions; do not leave them disabled with no reason |
| Busy button | `isLoading loadingText="Ukládám…"` |

## Gotchas from the ui-kit skills (verified in source)

- **Create/edit drawer = `Dialog placement="right"`**, not `Drawer`. Drawer is for mobile filters/cart only.
- **DataTable default page size is 10** (`pageSizeOptions[0]`). Set `[50, 100, 200]`.
- **Pinned columns need numeric widths.** Enum filter selects stretch columns unless `tableLayout="fixed"`.
- **`stickyHeader` needs `maxHeight`** to get a scrolling body.
- **`meta.align: 'end'` is not inferred** from `meta.type: 'number'`. Set both. Add `tabular-nums` yourself.
- **`translations.emptyTitle` holds one message.** Use `renderEmpty` and branch on error / filtered / first use.
- **Row actions** go in the `rowActions` array: `{ id, label, icon, tone?: 'danger', hidden?, disabled?, onAction }`. Delete goes last with `tone: 'danger'`.
- **Toolbar** allows ≤3 `toolbarActions`. The page primary goes in `PageHeader`, not the toolbar.
- **Shift-click range selection is off.** Inline edit locks sort, filter and paging while a row is edited.
- data-table-usage still says "no date-picker yet". That text is stale: `molecules/date-picker` exists. Filters still use native date inputs.
- **Chart has no x formatter.** Pass pre-formatted, sorted labels (`fmt.month`). `formatValue` formats y only. `ariaLabel` is required. ≤6 series; Chart warns and wraps colours.
- **Locale defaults differ**: DatePicker uses en-US, NumericInput uses cs-CZ. Always pass `locale="cs-CZ"`.
- **Combobox `onChange` gives an array**, even in single mode: `values[0] ?? null`.
- **SelectTemplate `value` is `string[]`**: `value={[x]}`, `onValueChange={(d) => d.value[0]}`.
- **Badge variants in Akros**: `secondary` is green, `tertiary` equals `info`, `primary` equals the warning yellow. Use only outline/info/warning/success/danger.
- Do not mount `<Toaster />` in verticals. The shell owns the single one (bottom-end).
- Tailwind: decide prefixed vs unprefixed per `references/styling-tokens-and-design-rules.md` §1, and verify through the shell, never a standalone remote.

## Verify (every UI todo, before you report done)

Run the vertical's typecheck/tests, then look at the page through the running shell, logged in as `obchod@demo.ontos`:

```bash
cd /Users/satan/workspace
agent-browser --session default set viewport 1440 900
agent-browser --session default open "$SHELL_URL/cs/<route>"
agent-browser --session default screenshot --full /Volumes/TraceDecayKingston/techsio-demo/screens/<page>-1440.png
agent-browser --session default set viewport 390 844
agent-browser --session default screenshot --full /Volumes/TraceDecayKingston/techsio-demo/screens/<page>-390.png
```

Open both screenshots and check every box:

```text
[ ] 1440 and 390 screenshots taken and inspected (nothing clipped, overlapping or horizontally overflowing the page; tables scroll inside their frame)
[ ] Akros look: yellow primary button, black text, white surfaces, neutral borders; no default-blue theme leaking
[ ] No raw ISO dates, no "NaN", "undefined", "null", "[object Object]", or English kit defaults ("Search…", "No records", "of", "Rows per page")
[ ] Money uses cs-CZ CZK ("1 234 Kč"), is end-aligned and uses tabular-nums; headers of numeric columns are end-aligned too
[ ] Empty, loading and error states each seen at least once (temporarily force them, or filter to nothing)
[ ] Czech diacritics correct everywhere (ě š č ř ž ý á í é ů ú ň ť ď); sentence case; no emojis
[ ] Exactly one primary per surface; destructive actions confirmed in an alertdialog naming the record
[ ] Every status badge comes from the status map; tags use TagBadge
[ ] Create → toast → row appears without a full reload; conflict path shows the inline error
```

Report the screenshot paths with your result.
