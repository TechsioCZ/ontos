# Quality audits

Run the pinned analyzers from `app/`:

```sh
mise exec -- pnpm quality:audit
mise exec -- pnpm quality:audit --tool knip
mise exec -- pnpm quality:audit --tool jscpd
mise exec -- pnpm quality:audit --tool fallow
mise exec -- pnpm quality:audit:test
```

The audit reports findings. Existing unused-code, duplication, and complexity findings do not fail the audit command. Missing tools, invalid reports, configuration failures, or an empty analysis are failures and retain diagnostics. A successful report does not prove every reported item should be removed or extracted.

The runner verifies each installed analyzer and invokes its package's JavaScript launcher with the current Node executable. This avoids package-manager shims and keeps installation a separate, explicit step.

The default output is `.codex/reports/quality-audit/`. Use `--output <path>` to select another directory outside the configured source roots. An output such as `scripts/reports`, including a symlink that resolves there, fails before analyzer snapshots are written, so reports cannot become source inputs. Read `summary.md` for the result, `summary.json` for structured status, and the raw analyzer reports and stderr for evidence. Reports are generated artifacts and should not be committed as an accepted baseline. Local run artifacts remain available until the user removes them; this deliberately retains review evidence. The runner does not automatically delete an arbitrary directory supplied through `--output`.

The separate **Quality Audit Reports** workflow publishes reports on pull requests and pushes to `main` and `stage`; it can also be run manually. It is not added to branch-required checks or stage deployment prerequisites in this rollout. Existing formatting, lint, type, architecture, and behavioral gates retain their current behavior. The audit does not install or activate local Git hooks. CI installs dependencies with `--ignore-scripts` to avoid lifecycle-script mutations while collecting reports.

## What each report answers

| Tool   | Report                                                                                 | Interpretation                                                                                                                         |
| ------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Knip   | Unused files, exports, types, dependencies, and import/dependency problems             | No consumer was found in the configured model. Framework roots and external consumers need review before removal.                      |
| JSCPD  | Substantial repeated token sequences                                                   | Candidate shared implementation, including copies of unchanged files.                                                                  |
| Fallow | Strict clones, separate semantic similarities, and control-flow complexity above 10/15 | Strict matches are primary clone observations; semantic matches are advisory. Complexity separates React heuristics from control flow. |

Use the checked-in analyzer configs and runner as the command and scope authority. They account for runtime source, tooling, tests, and framework consumers. Intentionally invalid custom-rule fixtures, dependencies, and generated build output require explicit handling; editable Codesmith starter files remain source. Discovery totals and clone-eligible file totals differ because clone detectors omit files shorter than their token/line minimums. Do not compare duplication percentages between tools as if they used the same denominator.

Knip must preserve filename-loaded Modern runtime files, route loaders and metadata, synthetic registration imports, Module Federation exposes, declared contract exports, separate worker processes, and tool/test loaders. An export listed in a package manifest is a compatibility boundary, not proof that every member has a current consumer. Disabling problematic dynamic configuration loading in the audit config requires explicit static roots; it is not permission to delete the corresponding tool dependencies.

Keep the existing compiler and lint checks. Some analyzers recover from malformed syntax and still emit JSON, so report validation does not replace syntax/type validation. Audit health metrics deliberately avoid using estimated coverage or an aggregate health score as a gate.

## Calibrated reporting model

Knip's model adapters inspect source and configuration syntax without evaluating application modules. They derive concrete consumer evidence for dynamic framework behavior, including federation package keys, subprocess source arguments, source-reading validators, reflective Drizzle schemas, and loader configuration. Each modeled consumer records its owning workspace, source location, target, and reason in `knip-model.json`. `provenance.json` records the Git revision, whether the working tree is clean or modified, and tracked/untracked changes; a modified scan is not attributed to the commit alone. The run retains both `configs/knip-base.json` and the effective `configs/knip.json` so the model's effect is reviewable.

The generated `knip-consumers.mts` snapshot expresses proven file, named-export, and root dependency consumption through scoped imports. Root dependency imports avoid Knip's inherited root exceptions, so a root consumer cannot hide an unused declaration in a child workspace. A file-only consumer does not imply that all of its exports are used; a reflected named export does not protect an unused neighboring helper. These imports belong to the temporary analyzer model and do not modify application imports or create runtime coupling between MicroVerticals.

Knip's `report.ndjson` remains the native report. The calibrated summary retains `nativeFindingCounts` alongside `findingCounts` and `modeledUsages`. The corresponding `knip/modeled-usages.json` records the exact original issue category and consumer evidence for each modeled usage, including an empty array when none apply. Resolver handling requires the actual source, line, column, package target, explicit resolution anchor, resolved path, and an `owningManifest` declaration proof. A vendor dependency chain must also be proved, including that the declaring producer resolves the same canonical installed target. Unproved resolver ownership remains a finding and records `resolver-unproven` evidence with the available paths and reason; dependency layouts can therefore produce different calibrated totals. A package that happens to resolve inside the same workspace without being declared remains a finding, as do unanchored imports elsewhere. A count change caused by corrected consumer modeling is not a code removal or an accepted-debt baseline.

The compiler-option correction applies only to Knip's exact locationless `@effect/language-service` record for `tsconfig.base.json`. It requires the pinned Effect TSGo manifest, documentation proving the plugin is built in, and evidence that the actual typecheck command chain uses that compiler. This configuration namespace does not imply an installed JavaScript plugin dependency. References in `types[]` and direct imports retain their findings.

Fallow runs `strict` mode for its primary clone report and `semantic` mode for the separate `fallow-similarity` advisory. Semantic normalization can match different numeric policies, string values, API contracts, and worker wiring, while also finding renamed implementations that strict mode misses. Both reports remain useful when their meanings stay explicit. JSCPD is an independent token detector. Never add JSCPD, Fallow strict, and Fallow semantic totals: their pairs, groups, and source spans overlap. Raw duplicated-line statistics are observations from the detector, not verified replaceable lines or distinct defect counts.

Fallow's raw cognitive metric includes the React contribution kinds `hook-density` and `prop-count`. The 10/15 policy concerns control flow, so the runner reconstructs the native metrics from each function's contributions and derives:

```text
cyclomatic = 1 + sum(cyclomatic contribution weights)
weightedCognitive = sum(cognitive contribution weights)
controlFlowCognitive = weightedCognitive - hookDensityWeight - propCountWeight
primaryViolation = cyclomatic > 10 || controlFlowCognitive > 15
```

The normalized `fallow-health/complexity.json` retains each function's path, line, name, raw weighted cognitive value, both React weights, projected control-flow cognitive value, and threshold classification. The report separates native weighted findings, control-flow findings, and UI-only advisories. A branch-free component whose props and hooks alone cross the native threshold is a UI advisory; a neighboring branch-heavy function remains a primary finding. Missing contribution evidence or arithmetic inconsistent with the native metrics is an analysis failure. This projection changes the metric interpretation without raising thresholds or excluding UI files.

## Review and maintenance

Rollout measurements, calibration evidence, and follow-up scope belong to [PR #492](https://github.com/TechsioCZ/ontos/pull/492).

An unused export identifies an unnecessary exported name or forwarding surface; it does not establish that its declaration or initializer can be deleted. Preserve locally used implementations and prove the intended public boundary before changing an export. Knip duplicate-export groups concern aliases and remain separate from JSCPD/Fallow body-clone observations.

ADR-0016 remains binding throughout. A clone between MicroVerticals never permits importing another deployment's private registration, handler, repository, worker, or business behavior. Repeat deliberate domain structure when ownership or type semantics require it and document the reason.

Tool upgrades must rerun the report integrity tests and representative real-source scans. Compare discovery, findings, native exit behavior, and report schemas before updating policy. An audit implementation defect is fixed in the reporting tooling; existing application debt stays in the corresponding follow-up PR.
