---
name: ontos-ui-decision
description: >
  Decide a genuinely uncertain OntOS UI choice without asking a human. Build 2–3 variants in place with
  ui.sh picker markers, screenshot each at 1440 and 390, have three judges (Opus 5.5, GLM 5.3 Flash,
  DeepSeek V4.1 Flash) score them on a fixed rubric, apply the majority pick (Opus breaks ties), clean up
  the scaffolding, and log the decision in app/docs/demo/ui-decisions.md.
---

# OntOS UI decision protocol

## When to use it

Use it only when **all** of these hold:
- The choice is visible to the Head of Sales and changes how fast they work: layout, navigation, list
  pattern, default view, or chart/builder arrangement.
- There are **at least 2 credible options**. Each one is consistent with `ontos-dense-admin` and the ui-kit
  `ux-guidelines`, and you cannot pick one by citing a rule.
- No rule already decides it. `ontos-dense-admin`, the kit `*-usage` skills and the Akros reference pages win
  whenever they answer the question. Do not run this protocol for copy, colour, spacing or component API questions.

Pre-planned decision points (from the sales-demo brief):

| Slug | Decision | Options |
|---|---|---|
| `shell-nav` | Shell navigation | A Akros TreeView sidebar · B ui-kit Sidebar rail + pane · C compact top bar + sidebar |
| `list-filters` | List page pattern | A filters row above the table (DataTable column filters + saved-view Tabs) · B FacetFilterPanel side panel |
| `stats-builder` | Statistiky builder layout | A left config panel · B top toolbar + presets |
| `opportunity-view` | Opportunity default view | A table (DataTable) · B kanban by stage |

Run each decision **once**, by the lane that owns the file. Other lanes reuse the logged outcome.

## 1. Frame the decision

Write down, before coding:
- `slug` (kebab-case), `label` (human-readable, e.g. `Seznam: filtry`)
- **Task under test**: one concrete Head of Sales job, e.g. *"Najdi všechny příležitosti ve vyjednávání se
  štítkem VIP a přeřaď je na Petra."* Judges score task speed against this.
- 2–3 options, each with a key letter and one sentence: `A: Řádek filtrů nad tabulkou (current)`. If one option is
  the current implementation, it is option A and its label ends with `(current)`.

## 2. Build the variants in place

Work in the real page file. Do not create a standalone preview file. Use real data from the running stack.

```tsx
// Use the vertical's Tailwind prefix for `contents`, e.g. salespipeline:contents.
// Use plain `contents` only if the shell @sources verticals (see dense-admin styling reference).
<div data-uidotsh-pick="Seznam: filtry" className="salespipeline:contents">
  <div data-uidotsh-option="A: Řádek filtrů nad tabulkou (current)" className="salespipeline:contents">
    <FiltersRowVariant {...shared} />
  </div>
  <div data-uidotsh-option="B: Boční panel s fasetami" className="salespipeline:contents" hidden>
    <FacetPanelVariant {...shared} />
  </div>
</div>
```

Rules:
- Exactly one option is visible (the first). All others carry `hidden`. Every option is complete and
  usable, not a sketch, and follows `ontos-dense-admin` (Czech copy, formatting, states).
- Hoist data loading and shared state **above** the pick wrapper and pass it down as props. Variants must not
  each fetch or each mount a second `<Toaster/>`.
- Make DOM ids unique per variant (`id={`opp-title-${variantKey}`}`) so hidden variants do not duplicate ids.
- Keep variant components in the same file, or in a sibling file named `*.variant-<key>.tsx` that you will
  delete at finalize.
- Do **not** inject `https://ui.sh/ui-picker.js` for this agent-driven protocol. Its toolbar would appear in
  the screenshots, and the shell layout belongs to plan 03. Only if a human explicitly asks to preview, ask the
  orchestrator to add `<Helmet><script src="https://ui.sh/ui-picker.js" /></Helmet>` once in
  `app/apps/shell-super-app/src/routes/layout.tsx`. Remove it at finalize.

## 3. Screenshot every variant (1440 and 390)

Use the persistent browser profile from `/Users/satan/workspace`, logged into the shell as `obchod@demo.ontos`
(password `password1234`). `$SHELL_URL` is the local shell dev URL from plan 01.

```bash
cd /Users/satan/workspace
OUT=/Volumes/TraceDecayKingston/techsio-demo/ui-decisions/<slug>; mkdir -p "$OUT"
agent-browser --session default open "$SHELL_URL/cs/<route>"
agent-browser --session default wait 1500
# For each option key K with label "$LABEL":
agent-browser --session default eval "(() => {
  const pick = document.querySelector('[data-uidotsh-pick=\"Seznam: filtry\"]');
  const opts = [...pick.querySelectorAll(':scope > [data-uidotsh-option]')];
  opts.forEach((o) => { o.hidden = o.getAttribute('data-uidotsh-option') !== '$LABEL'; });
  return opts.map((o) => o.getAttribute('data-uidotsh-option') + '=' + !o.hidden).join(' | ');
})()"
agent-browser --session default set viewport 1440 900
agent-browser --session default wait 400
agent-browser --session default screenshot --full "$OUT/K-1440.png"
agent-browser --session default set viewport 390 844
agent-browser --session default wait 400
agent-browser --session default screenshot --full "$OUT/K-390.png"
agent-browser --session default snapshot > "$OUT/K-snapshot.txt"   # text fallback for judges without vision
```

- Check the eval output: exactly one `=true`, and it is the intended option. If React re-rendered and reset
  `hidden`, run the eval again directly before each screenshot.
- If the task under test needs an interaction (open the drawer, select rows), perform the same interaction for
  every variant before its screenshot, and add a `K-1440-<step>.png`.
- Open every PNG yourself. Re-take any screenshot that shows a loading skeleton, an error, or the wrong variant.
- Write `$OUT/packet.md` with the slug, label, task under test, option list (key + one sentence) and all
  screenshot paths.

## 4. Judge panel (three judges, same prompt)

Fill in the prompt below. Use the same text for every judge.

```text
You are a senior B2B admin-UI reviewer. Judge UI variants for OntOS, a Czech ERP/CRM back office used by the
Head of Sales. Theme: Akros (yellow primary buttons with black text, black body text, white surfaces, neutral grey borders) built on
the @techsio/ui-kit design system. Do not modify any files.

Decision: <label>
Task under test: <task>
Options:
<K>: <one sentence> — screenshots: <abs path K-1440.png>, <abs path K-390.png> (text: <K-snapshot.txt>)
...
Open and look at every screenshot (desktop 1440 weighs twice as much as mobile 390).

Score each option 1–5 on each criterion:
1 density       — decision-relevant information visible without scrolling, without clutter
2 scanability   — status, money, owner and dates are found at a glance; alignment and hierarchy are clear
3 brand         — Akros/brand fidelity: sparing yellow primary, black text, calm surfaces, correct Czech copy
4 taskSpeed     — how few steps and how little time the Head of Sales needs for the task under test
5 consistency   — consistency with ui-kit patterns: one primary action top-right, right-side drawer
                  for CRUD, kit components only, no custom widgets
total = sum (5–25). Rank by total; break ties by taskSpeed, then density.

Reply with ONLY this JSON, no prose, no code fence:
{"ranking":["B","A"],
 "scores":{"A":{"density":0,"scanability":0,"brand":0,"taskSpeed":0,"consistency":0,"total":0},
           "B":{"density":0,"scanability":0,"brand":0,"taskSpeed":0,"consistency":0,"total":0}},
 "reasons":{"A":"<=40 words","B":"<=40 words"},
 "sawImages":true}
```

Launch all three in parallel (one message, three tool calls):

| Judge | Tool | Call |
|---|---|---|
| Opus 5.5 | Claude `Agent` tool | `subagent_type: "general-purpose"`, `model: "opus"`, `description: "UI judge <slug>"`, `prompt: <judge prompt>`, `run_in_background: false` |
| GLM 5.3 Flash | T3 `mcp__t3-code__delegate_task` | `task: <judge prompt>`, `target: { providerInstanceId: "cliproxy", model: "factory/glm-5.3-flash" }`, `role: "review"`, `mode: "wait"`, `timeoutMs: 600000`, `title: "UI judge <slug> GLM"`, `clientRequestId: "ui-judge-<slug>-glm"` |
| DeepSeek V4.1 Flash | T3 `mcp__t3-code__delegate_task` | same as above with `model: "factory/deepseek-v4.1-flash"`, `clientRequestId: "ui-judge-<slug>-deepseek"` |

(Load the T3 tool schema first with `ToolSearch` `select:mcp__t3-code__delegate_task,mcp__t3-code__task_status`.
If a wait times out, read the result later with `task_status(taskId)`.)

Save each raw reply to `$OUT/judge-<opus|glm|deepseek>.json`.

**If you cannot call the `Agent` tool or `delegate_task`** (for example, you are a sub-agent without them),
stop after step 3. Leave option A visible and report `DECISION PACKET READY: $OUT/packet.md` to your
orchestrator, who runs step 4. Continue with work that does not depend on the outcome.

## 5. Decide

1. Parse each reply. On invalid JSON, re-ask that judge once with "Return only the JSON object."
   If it still fails, drop that judge and note it.
2. If `sawImages` is false or the judge says it cannot view images, re-ask once with the `K-snapshot.txt` contents
   and the option sentences inlined. Mark that vote "text-only".
3. Each judge's winner is `ranking[0]`.
   - Two or more judges share a winner → that option wins (majority).
   - All three differ, or only two valid judges disagree → **Opus's winner wins** (tie-break).
   - Opus invalid twice → the option with the highest summed `total` across the valid judges wins.
4. Merge the winners' `reasons` into 2–3 bullets. If a losing option scored higher on one criterion and that
   idea fits the winner without changing the pick (e.g. a saved-view tab), you may fold it in. Record that you did.

## 6. Finalize (ui:ideas cleanup rules)

1. Keep only the winning option's markup and unwrap it: delete the pick wrapper, the option wrapper,
   `data-uidotsh-*` attributes, the `contents` classes and every `hidden` added for scaffolding.
2. Delete the losing variants, their `*.variant-<key>.tsx` files, and state, helpers, imports and locale keys
   used only by them. Remove picker script usage first, then its imports, in one edit.
3. Remove temporary comments and lint suppressions added for the variants. Make sure no duplicate ids remain.
4. Check that nothing is left: `grep -rn "data-uidotsh\|ui-picker.js" app/` returns nothing.
5. Run the touched package's typecheck, lint and tests. Re-take final 1440 and 390 screenshots, then go through
   the `ontos-dense-admin` verify checklist.
6. Keep `$OUT` (outside the repo) as evidence. Never commit screenshots.

## 7. Record the decision

Append a section to `app/docs/demo/ui-decisions.md`. Create the file with a `# OntOS demo UI decisions` heading if it is missing.
Re-read the file right before editing (other lanes append too). Add only your section at the end, and commit it
with your todo.

```markdown
## <slug>: <label> (2026-10-13)

- Task under test: <task>
- Options: A <sentence> · B <sentence> · C <sentence>
- Votes: Opus 5.5 → B (B 22 / A 18) · GLM 5.3 Flash → B (21 / 19) · DeepSeek V4.1 Flash → A (20 / 21)
- Decision: **B**, majority 2/3   <!-- or: tie broken by Opus -->
- Why: <bullet 1>; <bullet 2>; <bullet 3>
- Folded in from losers: <none | what>
- Notes: <dropped judges, text-only votes>
- Evidence: /Volumes/TraceDecayKingston/techsio-demo/ui-decisions/<slug>/
- Files: <paths changed>
```
