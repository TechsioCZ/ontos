# OntOS demo UI decisions

## shell-nav: Shell: navigace (2026-10-13)

- Task under test: Head of Sales is on Příležitosti, jumps to Faktury, then Statistiky; on a phone opens the navigation and switches to Úkoly.
- Options: A Akros TreeView sidebar (AdminShell reference) · B ui-kit Sidebar rail of groups + pane with the selected group's links · C compact full-width top bar + collapsible grouped ui-kit Sidebar
- Votes: Opus 5.5 → C (C 23 / A 19 / B 16) · GLM 5.3 Flash → A (A 23 / C 22 / B 19) · DeepSeek V4.1 Flash → no result
- Decision: **C**, tie broken by Opus (two valid judges disagreed)
- Why: every group and destination is visible with a label, so each jump is one click; the current page is highlighted and repeated as a trail in the top bar; kit-only Sidebar with icon collapse and a built-in drawer below lg.
- Folded in from losers: none (B's rail was rejected by all judges: it hides other groups and adds a click per area switch).
- Notes: DeepSeek V4.1 Flash timed out, then the T3 delegate tool lost its parent run, so it was dropped. Variants were judged on a temporary fixture route with all demo modules active (removed after the decision).
- Evidence: /Volumes/TraceDecayKingston/techsio-demo/evidence/03-nav-_.png, 03-nav-packet.md, 03-nav-judge-_.json
- Files: app/apps/shell-super-app/src/routes/shell-frame.tsx, app/apps/shell-super-app/locales/{cs,en}/shell.json, app/apps/shell-super-app/tests/unit/layout.test.tsx

## stats-builder: Statistiky: rozložení (2026-10-13)

- Task under test: Zjisti tržby z faktur za posledních 12 měsíců po obchodnících, pak přepni ukazatel na váženou pipeline a typ grafu na koláč a celou dobu sleduj KPI.
- Options: A Panel vlevo: svislý panel nastavení (18rem) vlevo, KPI, graf a tabulka vpravo · B Lišta nahoře: stejné ovládací prvky v jednom řádku nad KPI, grafem a tabulkou na plnou šířku
- Votes: Opus 5.5 → B (B 19 / A 18) · GLM 5.3 Flash → no result · DeepSeek V4.1 Flash → no result
- Decision: **B**, Opus vote (only valid judge)
- Why: full-width KPI cards show every amount without clipping (A cut off 3 078 504 Kč and 671 229,35 Kč); a filter bar on top is the familiar kit pattern and stacks compactly on mobile; A left empty space under the panel.
- Folded in from losers: none. Opus noted that the Období column with its presets broke row alignment, so the bar now aligns fields to the top (`items-start`) instead of the bottom.
- Notes: both T3 `delegate_task` calls failed with `parent_not_active` (the lane ran as a subagent without a T3 parent run), so GLM and DeepSeek were dropped. The live build did not generate A's `xl:grid-cols-[18rem_minmax(0,1fr)]` class, so A-1440 was judged with injected CSS that emulates the intended grid (unemulated render: `20-stats-A-1440-unstyled.png`).
- Evidence: /Volumes/TraceDecayKingston/techsio-demo/evidence/20-stats-{A,B}-{1440,390}.png, 20-stats-packet.md, 20-stats-judge-{opus,glm,deepseek}.json
- Files: app/verticals/sales-insights/src/routes/[lang]/prehledy/statistiky/page.tsx, app/verticals/sales-insights/src/statistics/statistics-controls.tsx, app/verticals/sales-insights/locales/{cs,en}/sales-insights.json

### Statistiky: rozložení — final vote (orchestrator re-run of cheap judges)

| Judge               | Pick | Scores (A / B) | Note                                                    |
| ------------------- | ---- | -------------- | ------------------------------------------------------- |
| Opus 5.5            | B    | 18 / 19        | Narrow KPI cards in A truncate amounts                  |
| DeepSeek V4.1 Flash | B    | 20 / 21        | Standard kit filter-bar pattern; presets wrap on mobile |
| GLM 5.3 Flash       | A    | 20 / 19        | Persistent panel is faster for repeated tweaking        |

Result: **B (Lišta nahoře)**, 2–1. Follow-up: tidy period-preset wrapping at 390 px.
