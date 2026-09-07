# Quality audits

Run the pinned analyzers from `app/`:

```sh
mise exec -- pnpm quality:audit
mise exec -- pnpm quality:audit --tool knip
mise exec -- pnpm quality:audit --tool jscpd
mise exec -- pnpm quality:audit --tool fallow
mise exec -- pnpm quality:audit:test
```

The first rollout reports findings. Existing unused-code, duplication, and complexity findings do not fail the audit command. Missing tools, invalid reports, configuration failures, or an empty analysis are failures and retain diagnostics. A successful report does not prove every reported item should be removed or extracted.

The default output is `.codex/reports/quality-audit/`. Use `--output <path>` to select another directory. Read `summary.md` for the result, `summary.json` for structured status, and the raw analyzer reports and stderr for evidence. Reports are generated artifacts and should not be committed as an accepted baseline.

The separate **Quality Audit Reports** workflow publishes reports on pull requests and pushes to `main` and `stage`; it can also be run manually. It is not added to branch-required checks or stage deployment prerequisites in this rollout. Existing formatting, lint, type, architecture, and behavioral gates retain their current behavior. Local Git hook activation is a separate follow-up, because the audit found that the root Lefthook example did not load the application configuration through the effective global hook chain.

## What each report answers

| Tool   | Report                                                                     | Interpretation                                                                                                    |
| ------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Knip   | Unused files, exports, types, dependencies, and import/dependency problems | No consumer was found in the configured model. Framework roots and external consumers need review before removal. |
| JSCPD  | Substantial repeated token sequences                                       | Candidate shared implementation, including copies of unchanged files.                                             |
| Fallow | Structural clones and functions above cyclomatic 10 or cognitive 15        | Candidate duplication or complexity to inspect. Structural normalization is not proof of equivalent behavior.     |

Use the checked-in analyzer configs and runner as the command and scope authority. They account for runtime source, tooling, tests, and framework consumers. Intentionally invalid custom-rule fixtures, dependencies, and generated build output require explicit handling; editable Codesmith starter files remain source. Discovery totals and clone-eligible file totals differ because clone detectors omit files shorter than their token/line minimums. Do not compare duplication percentages between tools as if they used the same denominator.

Knip must preserve filename-loaded Modern runtime files, route loaders and metadata, synthetic registration imports, Module Federation exposes, declared contract exports, separate worker processes, and tool/test loaders. An export listed in a package manifest is a compatibility boundary, not proof that every member has a current consumer. Disabling problematic dynamic configuration loading in the audit config requires explicit static roots; it is not permission to delete the corresponding tool dependencies.

Keep the existing compiler and lint checks. Some analyzers recover from malformed syntax and still emit JSON, so report validation does not replace syntax/type validation. Audit health metrics deliberately avoid using estimated coverage or an aggregate health score as a gate.

## Initial source audit

A parallel audit inspected source revision `3c6faedcccb0d86f7c0df40e2e826edddc82c6d5` before the reporting integration. Those observations belong to that source revision and the audit's stated corpora. Running the integrated command on a later commit can produce different totals.

The broad audit inventoried 3,181 JavaScript and TypeScript files. The recurring report excludes 2,248 custom-rule fixture files and two generated Modern TanStack router files, and adds three audit implementation files, giving 934 source files at integration time. Fallow additionally discovers four CSS files. Custom-rule fixture behavior remains covered by the existing lint-rule tests. Clone-eligible totals also change with these exclusions and each detector's minimum size.

| Observation                  | Audit evidence and limit                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knip ordinary analysis       | 14 files, 388 exports, 201 types, 21 dependencies, and 15 development dependencies reported unused. Remaining framework, public-contract, and installation-model uncertainties prevent treating these as deletion counts. |
| Knip production analysis     | 17 files, 529 exports, 256 types, and 30 dependencies reported unused under a separate production model. This is not a deployed-bundle proof.                                                                             |
| JSCPD runtime/tooling corpus | 235 clone pairs; 145 pairs wholly inside `tools/oxlint`. Large families repeat lexical-scope and Effect-binding helpers.                                                                                                  |
| Fallow broad audit           | 449 structural clone groups; 568 functions above the proposed 10/15 limits, including 402 in quality tooling. This broad audit included tests and fixture observations separately.                                        |
| Existing policy              | Classic cyclomatic complexity defaults to 20; cognitive complexity is disabled in the application config. Party Registry has a migration override disabling 39 rules for `.ts` files.                                     |

No audit findings were automatically repaired or accepted into a permanent baseline. The broad source audit also validated consumer roots and isolated detector failure behavior. In particular, all three analyzers can return success on empty inputs, and Fallow's duplication subcommand cannot be gated by assuming `--fail-on-issues` works like its other analyses.

## Follow-up PR boundaries

Keep each correction independently reviewable:

1. **Consumer-model corrections.** Prove runtime, federation, worker, test-loader, and externally consumed contract roots. Resolve false unused reports before deleting code. Include unused-neighbor controls so broad entry patterns cannot hide defects.
2. **Custom Oxlint helper consolidation.** Start with lexical provenance and Effect-binding clone families. Preserve invalid/valid fixtures and rule-specific diagnostics; do not merge distinct provenance semantics just because token sequences match.
3. **Unused artifacts by owner.** Remove confirmed unused exports, types, files, or dependencies in separate owner-scoped changes after consumer proof and fresh-install verification.
4. **Owner-local clone and complexity repairs.** One cohesive API, script, or operation family per PR. Preserve typed failures, authorization order, transaction boundaries, resource lifetime, and overload narrowing.
5. **Generator/framework duplication.** Fix repeated generated helpers at their producer or approved shared layer, with regeneration and independent deployment proof.
6. **Policy and suppression governance.** Make complexity definitions explicit, narrow broad migration overrides, and validate owned expiring exceptions independently of the analyzer they suppress.
7. **Install lifecycle and source integrity.** Existing postinstall runs write-mode Oxfmt before validation. Correct that separately and prove a deliberately unformatted tracked file survives installation unchanged and then fails the format check. The new audit workflow uses `--ignore-scripts` to avoid that behavior without changing existing workflows.
8. **Hook and pipeline enforcement.** Prove staged/pushed-tree semantics and the effective hook chain; then require validated quality checks on protected branches and the actual stage-deployment revision.

ADR-0016 remains binding throughout. A clone between MicroVerticals never permits importing another deployment's private registration, handler, repository, worker, or business behavior. Repeat deliberate domain structure when ownership or type semantics require it and document the reason.

Tool upgrades must rerun the report integrity tests and representative real-source scans. Compare discovery, findings, native exit behavior, and report schemas before updating policy. An audit implementation defect is fixed in the reporting tooling; existing application debt stays in the corresponding follow-up PR.
