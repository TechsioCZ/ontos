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
