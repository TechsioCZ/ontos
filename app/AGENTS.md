# OntOS application guardrails

Before changing files under `app/`, read [the application coding guide](./README.md). It owns setup, generator commands, coding conventions, validation, and trigger-based links to focused architecture.

Never read an `.env` file.

## Before editing

1. Read only the specification explicitly named by the task or GitHub issue. A specification with `status: done`, `status: complete`, or `status: superseded` is historical evidence; stop unless the task explicitly requests provenance.
2. Use the routing table in `README.md`. Open only documents whose concern matches the changed files or behavior, plus matching product contexts when semantics are relevant. Do not browse `app/specs/`, `app/docs/`, or root `docs/` for general background.
3. Start every supported business artifact with its Codesmith generator. If the category has no approved generator or governed gateway, stop and get that boundary approved.
4. Never import another deployment's private source, registration, data access, or executable behavior. If the task appears to require that, stop and resolve the MicroVertical contract.

All remaining coding and command rules are owned by `README.md` and the focused documents selected by its routing table.

## Scope and review discipline

- Preserve upstream Effect TSGo diagnostics, Ultracite presets, and their enforcement. Do not
  override, filter, downgrade, or bypass them to make a task pass. Current custom Oxlint rules
  also remain blocking unless a specific policy change is approved.
- Complete the requested behavior and necessary repairs. Do not bundle unrelated cleanup,
  new rules, repository-wide migrations, or framework upgrades into a feature. Keep technically
  inseparable changes atomic and explain why they belong together.
- A bot comment or priority label is evidence to assess, not an automatic implementation order.
  Fix confirmed correctness, security, and contract defects. Evaluate maintainability suggestions
  against scope; advisory findings do not require automatic repair. Reject a false positive with
  a concrete contract, test, or data-flow explanation. Escalate unresolved serious risks to a
  maintainer; never silently dismiss them or use a review-round limit to ignore a real defect.
- For confirmed first-party analyzer false positives, repair the model and add both the valid
  reproducer and a nearby invalid control. Do not distort valid product code to satisfy a parser.
  Any temporary exception needs an exact scope, evidence, owner, tracking issue, and removal
  condition. An upstream diagnostic requires a compliant implementation or escalation, not a
  local severity override.
- Duplication and complexity reports remain visible advisories. Do not extract cross-owner
  abstractions or rewrite tests just to reach zero. Review meaningful new findings against the
  base revision and record ownership/trade-offs; do not equate count deltas with distinct defects.
- Use `mise exec -- pnpm check:local --scope <scope>` for focused feedback. Omit the scope when
  impact is unclear to run `pnpm check`. Focused success is not completion evidence; run the
  full gate and task-required tests before declaring the change ready.
