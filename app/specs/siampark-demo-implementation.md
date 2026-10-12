# Siampark demo implementation

Status: blocked

Implement the ten presentation scenarios in
[`../../docs/SIAMPARK_DEMO_IMPLEMENTATION_SPEC.md`](../../docs/SIAMPARK_DEMO_IMPLEMENTATION_SPEC.md),
using the decisions in `.codex/plans/siampark-issues/` as source context. The user explicitly
authorized implementation in the current checkout on 2026-10-06, overriding the Locki sandbox
requirement for this task. Existing research issues and plans are not implementation evidence.

## Requirements

Six generated business owners preserve Property, Occupancy, Agreements, Work, Billing/Finance,
and Relationships boundaries. Reuse Core authentication, Actions, governed reads, module lifecycle,
resource authorization, and Party Registry identity. Cross-owner calls use public contracts.
All mutable demo state is durable and transaction-scoped. Provider effects may be simulated and
must be displayed as such. Availability, expiry, overdue balances, and dashboard numbers are derived.

Seed/reset owns only a synthetic demo tenant, legal entity, principals, grants and owner fixtures.
The business date is 2026-10-05 in Europe/Prague; audit timestamps retain actual time.
Reset must restore a repeatable baseline after all ten scenarios.

## Step by Step Tasks

- [x] Generate six deployment units, module contracts, resources, Actions, reads and pages.
- [x] Implement owner-local schemas, scoped persistence and typed state-machine failures.
- [x] Implement real role/resource restrictions, explicit Action grants and deterministic fixtures.
- [x] Connect translated pages to generated Effect clients and real persisted state.
- [x] Compose overview, calendar, finance reporting and owner integration observations.
- [x] Verify golden occupancy/contract/signature/invoice flow, short stay, maintenance, renewal,
      supplier costs, overdue payment, relationship activity, management reporting, external denial,
      integration recovery and repeatable reset.
- [ ] Run focused tests, full repository checks and build; review and fix the final diff.

## Acceptance Criteria

All ten source scenarios execute from the reset fixture in the actual application. A101 starts free
and becomes occupied through Actions. External users can read assigned records and receive a
server denial for known unrelated Task and Invoice identifiers. Accounting retries preserve the
invoice and correlation; payment remains independent from accounting state. No private owner
imports, replacement identity system, statutory ledger, generic workflow or integration hub.

## Validation Commands

Run owner-owned focused unit/integration tests, database migration/check commands, and browser
validation of the ten scenarios. Then run `mise exec -- pnpm check` and
`mise exec -- pnpm build` from `app/`. Never bypass hooks or diagnostic rules.

## Demo operation

From `app/`, restore the complete deterministic baseline with one command:

```sh
mise exec -- pnpm demo:reset
```

`mise exec -- pnpm demo:reset --validate-only` checks configuration and all fixture inputs without
running migrations or changing data. Both database identities must target the same local
`siampark_demo` database. Secrets are loaded by the operator and are never printed.

With current development artifacts prepared, `mise exec -- pnpm demo:serve` starts the owning
applications. `mise exec -- pnpm demo:composition` observes their actual contracts and manifests,
publishes the canonical development composition and serves it on port 3031. The Shell preview is
on port 3020. Keep both operators running while demonstrating the application.

Demo logins are `management@siampark.demo`, `operations@siampark.demo`, `finance@siampark.demo` and
`external@siampark.demo`, with the synthetic fixture password `password1234`. The Operations
account presents the mutation scenarios; the External account demonstrates assigned records and
denial. The business date remains 2026-10-05 in Europe/Prague; audit timestamps use actual time.

## Implementation Evidence

### Summary

Six Codesmith-generated owners implement owner-local resources, typed Actions, governed reads,
translated pages, migrations, PostgreSQL persistence, revision checks and scoped authorization.
Property composes public owner reads for related occupancies, contracts/documents, tasks and finance.
Overview and agenda derive their values and link to the owning records. Provider observations expose
their simulation mode, timestamps, stable correlation, owner reference and safe receipt. A seeded
successful email notification is owned by Relationships and is visible only with its owner Activity.

The reset validates both database identities before migration and requires the same local
`siampark_demo` database. It restores nine owner ports, synthetic identities, exact Action/resource
grants and native Party search projections. No application startup performs a reset.

Implementation, focused tests, live HTTP acceptance, browser acceptance and the final repository
quality gate are verified. The remaining validation is the required promotable production
build, which previously rejected the dirty checkout's source revision `workspace`.
The user has now explicitly authorized committing and pushing this implementation to GitHub
`main`. Development builds and a running preview do not resolve the production-build gate.

### Changed Files

The change includes six generated deployment trees under `verticals/siampark-*`, their public
contracts, routes, translations, owner tests and migration histories; topology/workspace wiring;
the isolated demo operators; shared public gateway contracts and verifier/runtime repairs; and
generator/analyzer regression tests. Final review counted 39 changed tracked files (6,098 added
and 534 removed lines) and 417 new files. The new trees include generated contracts, database
migration snapshots and owner source/tests. Git diff statistics exclude those untracked files;
the combined change is 456 files, with approximately 40,900 added lines and 534 removed lines.

### Tests Written or Updated

- Six owner unit suites prove transitions, reference/date/scope validation, derived summaries,
  immutable draft anchors, payment versus accounting state, replay, retry and resource filtering.
- Shell's live HTTP suite uses actual authentication and generated clients across deployment
  boundaries. It verifies the golden lease, renewal, payment/retry, activity/follow-up, exact
  External Agent access/denial, Management capability and concurrent revision conflict.
- Core's two-connection PostgreSQL regression proves a nested governed Read commits its access
  evidence while the parent Action holds the tenant fence. A competing lifecycle writer remains
  blocked until parent settlement, then changes the module to read-only and causes typed denial.
- Operator tests prove invalid configuration starts no subprocess, validate-only performs no
  migration, and the native subprocess retains the managed toolchain path.
- Generator, entrypoint and Knip-model tests retain valid native consumers alongside nearby
  invalid controls. Public SDK tests retain the narrow Core root export boundary.

### Validation

Commands below were run from `app/` using the managed mise toolchain on 2026-10-06.

- `pnpm -r --no-sort --filter './verticals/siampark-*' run test:unit` passed all 44 final tests:
  Property 7, Occupancy 7, Agreements 9, Billing/Finance 12, Work 3, Relationships 6.
  Evidence: `/tmp/siampark-owner-unit-final44.log`.
- `pnpm test:generation` passed 142 tests. Evidence: `/tmp/siampark-generator-tests-final.log`.
- `pnpm test:scripts scripts/siampark/tests scripts/tests/siampark-search-fixture.test.mts
scripts/tests/lean-core-dependencies.test.mts scripts/tests/quality-audit-model.test.mts`
  passed 69 tests before the final native-directory Knip controls; those 15 model tests and all
  four final reset-entry tests subsequently passed separately.
- Core's focused integration file passed both tests. The final new regression timed out with
  the original `FOR UPDATE` fence and passed with `FOR NO KEY UPDATE`; nine gate unit tests,
  Core types and targeted lint/format also passed. Evidence:
  `/tmp/siampark-tenant-fence-final-red.log`, `/tmp/siampark-tenant-fence-final-green.log`.
- Shared SDK 111 unit tests and both type profiles passed; gateway verifier 20 tests passed;
  Node/workerd resolver tests passed; Core public surface 7 tests passed.
- `pnpm db:verify` passed exact schema/journal inventory, runtime grants, forced RLS,
  tenant/legal-entity isolation and exact external record visibility for all owners.
  Evidence: `/tmp/siampark-db-final-verify.log`.
- `pnpm demo:reset` passed migrations and all nine ports on the isolated demo database.
  The final strengthened operator also passed `pnpm demo:reset --validate-only` for all nine ports.
  Evidence: `/tmp/siampark-reset-current-source2.log`.
- All 17 native development builds passed with the tenant-fence repair. Both owners changed by
  the email repair also passed their final native rebuild. All 16 development module contracts
  and the Shell runtime metadata were regenerated normally. Agreements also passed its final
  expiry and translated-placeholder rebuilds. The final composition revision is
  `72cc19ea7608a740d07891ccb24c408dbc6596ba2bd5da457ac6845027102f52`; all 29 actual
  HTTP artifacts returned 200 and their SHA256 matched the publication.
  Evidence: `/tmp/siampark-core-fence-build-all.log`, `/tmp/siampark-final-email-build-all.log`,
  `/tmp/siampark-final-aui-build-agreements.log`,
  `/tmp/siampark-final-aui-module-shell-contracts.log`.
- `pnpm --filter @app/shell-super-app exec rstest --project integration
tests/integration/siampark-demo-http.test.ts` passed all eight tests, zero failed or skipped,
  process exit 0, in 24.36 seconds. The actual golden A101 flow includes draft editing, same-ID
  activation, signed FINAL document and a confirmed/synced 15,000 CZK invoice. Renewal preserves
  expiry count while clearing missing-renewal attention. Payment/accounting retries preserve
  correlation and reject duplicate effects. Management receives read-only capabilities and the
  seeded email observation; External receives its exact Task, Activity and Counterparty, typed
  403 for unrelated records and no unrelated email observations. Concurrent Task mutations yield
  one success and one typed 409 with exactly one revision increment.
  Evidence: `/tmp/siampark-live-http8-final-expiry.log`.
- Fresh pinned Knip audit reports zero remaining findings across 6,180 files. Evidence:
  `.codex/reports/siampark-knip-native-directory/summary.md`. This is not a full gate pass.
- Final `pnpm check` passed the complete canonical suite with process exit 0, including all
  architecture/generation boundaries, fresh Knip, suppression baseline, formatting, typed lint,
  native typecheck, pinned skills, i18n, native API/Party baseline, OntOS API, contracts and
  performance gates. The signature contact placeholder uses both native locale resources.
  No diagnostics, enforcement rules or hooks were bypassed.
  Evidence: `/tmp/siampark-full-check-final-locales.log`.
- Required `pnpm build` failed at the native promotable release envelope because source revision
  `workspace` is not a committed release revision. Evidence: `/tmp/siampark-build-resumed.log`.
  Development build success does not establish a promotable release build.

### Review

Reviewed both applicable `AGENTS.md` files, `README.md`, development and focused architecture
guidance for Actions, operation scope, database ownership, MicroVertical/public contracts,
entrypoints, manifests, Party Registry, typed errors, frontend and quality gates.

All ten presentation flows were checked in the actual T3 shared browser on port 3020, starting
from the nine-port baseline in `/tmp/siampark-browser-baseline-reset.log`. UI mutations used the
visible controls and generated clients; browser evaluation was limited to reading rendered state,
HTTP status and scrolling.

1. Operations selected canonical Eva and A101, created and confirmed the lease, created the linked
   contract, explicitly entered the signing contact, sent/completed the signature simulation,
   saw the signed final document, activated the same contract and occupancy, then created,
   confirmed and synchronized a linked 15,000 CZK invoice.
2. Short-stay filtering showed A103's confirmed dates and booking correlation, successful import
   observation, provider/time/request/result metadata, and the independent collision warning.
3. HVAC-01's real linked Work task moved from New to In Progress to Done. Its original creation
   time and actual changed time were visible; the canonical Property asset remained Active.
4. B201 renewal created a linked successor Draft with the original contract reference. The original
   contract remained Active and expiring; missing-renewal attention cleared.
5. Management opened the supplier invoice's canonical Counterparty detail, showing Servis Park
   DEMO, ORGANIZATION and Supplier, with the property's real cost and no Finance write controls.
6. B201's confirmed 18,000 CZK payment cleared overdue attention while accounting remained Failed.
   A separate retry and simulated acknowledgement recovered accounting on the existing invoice.
7. Operations searched canonical Petr, selected the existing B201 renewal Work task, recorded a
   call and saw the new Activity in chronology with its real follow-up link. No duplicate task.
8. Management's derived dashboard showed occupied 3/5, available 1, reserved 1, revenues 49,000,
   costs 6,800, receivables 15,000, payables 6,800, open invoices 3/overdue 0, open tasks 3/overdue 0,
   expiring 1, missing-renewal 0 and Activities 4. The Property drill-down showed both actual leases,
   contracts, final documents, invoices, linked tasks and occupied A101.
9. External Agent saw only its assigned B201 Task/Activity and canonical Petr contact. The known
   unrelated HVAC Task returned actual HTTP 403 and a localized denial, without task data;
   direct Finance navigation was denied by Shell. The live HTTP suite separately proves the
   typed invoice and unrelated Counterparty denials.
10. Integrations showed real owner observations for accounting, booking, signature and email,
    with DEMO/SIMULATED, stable correlations, times and receipts. Failed B201 accounting was
    inspected before recovery; payroll remains the explicitly prescribed placeholder.

After browser mutations, the final native reset passed all nine ports with exit 0 and restored
all six aggregate revisions to zero. Evidence:
`/tmp/siampark-final-browser-repeatability-reset.log`. Actual UI rereads showed only the original
three occupancies, no A101 lease, and the baseline dashboard: occupied 2/5, available 2, reserved 1,
revenues 34,000 CZK, costs 6,800 CZK, receivables 18,000 CZK, invoice overdue 1, tasks open 4/overdue 1,
expiry 1, missing-renewal 1, Activities 3, booking warning 1 and accounting warning 1. The final
shared tab is connected and visible on `/cs/siampark/overview` as Operations. All 17 servers and
the composition publisher remain running, and the unrelated existing port 3030 is untouched.

Review screenshots (five, captured from the native shared browser):

- `.codex/reports/review/siampark-demo-implementation/management-overview.png`
- `.codex/reports/review/siampark-demo-implementation/management-after-scenarios.png`
- `.codex/reports/review/siampark-demo-implementation/work-hvac-completed.png`
- `.codex/reports/review/siampark-demo-implementation/integrations-email.png`
- `.codex/reports/review/siampark-demo-implementation/external-unrelated-task-denied.png`

The final read-only advisory comparison uses preserved late implementation audit snapshots,
not a clean pre-feature baseline, and contains no source hashes. With identical inventory/config,
raw clone pairs increased by one: a 14-line native Read test fixture needed for the independent
Core two-connection regression. The six owners retain their separate generated public contracts;
merging these to reduce cloning would undermine deployment ownership. Complexity changed only
in the guarded audit path resolver (cyclomatic 14 to 16, cognitive 12 to 14); control-flow finding
count remains 804. No further in-scope review blocker was found. `git diff --check` passed.

Review repairs include exact Counterparty grant identity, native search projection bootstrap,
retaining draft references when editing, actual Work timestamps/selection after reread, strict
simulation observation metadata, the tenant-fence regression and bounded analyzer recognition
of valid native entrypoint/subprocess wiring. None introduces a private cross-owner import.
The renewal regression also proves that a successor draft resolves renewal attention while the
original active contract still reports its actual imminent expiry.

### Deviations and Follow-ups

- Current-checkout implementation is explicitly authorized by the user for this task.
- Shell's whole integration type profile reports 46 baseline diagnostics from external/generated
  dependencies; the live demo test file has none. Actual HTTP execution remains required.
- The promotable build requires a committed source revision. The user explicitly authorized
  committing and pushing to GitHub `main` on 2026-10-06. Release checks remain intact; the
  earlier failed production build is not success evidence.
- Accounting, payment, signature, booking and email outcomes are explicit demo simulations.
- GitHub research issues and the original research plans have not been changed by this code work.

### Storybook UI refinement (2026-10-06)

The user requested the visual structure of the supplied
[Akros Orders story](https://new-engine-ui-storybook.vercel.app/?path=/story/pages-akros-admin-orders--default).
Shell and all eight Siampark screens now use a light administration layout, compact navigation
with native icons and a yellow selected item, top-bar search, translated breadcrumbs, responsive
cards/forms, compact outline tables and independent semantic state badges. Presentation uses
installed Techsio UI-kit components/tokens and Tailwind; no component definitions, plain CSS,
backend clients or business operations were added for this refinement.

Resolved entrypoint identity distinguishes the three Property pages in navigation. Generic
catalog-discovered pages retain their labels, availability and stable relative order. Native
Helmet owns the document light-scheme utility with sufficient priority over the installed theme,
covering portalled menus/selects. The layout uses horizontal clipping so the sticky header/sidebar
remain anchored to the viewport.

Validation on the final implementation:

- 44 owner unit tests and 18 Shell layout tests passed; Property's seven tests and Shell's
  eighteen tests were rerun after the final presentation changes.
- Complete `pnpm check` passed: `/tmp/siampark-storybook-full-check.log`.
- Native Node development builds passed for Shell and all six Siampark owners. All 16 owner
  contracts and the Shell runtime contract were regenerated; all 17 contract endpoints returned 200.
- The native shared browser read actual records on Overview, Properties, Occupancy, Agreements,
  Finance, Work, Relationships and Integrations. Property related finance/occupancy/contracts/
  documents/tasks and invoice/contract details were checked without business mutations.
- Overview retained occupied 2/5, available 2, reserved 1, revenue 34,000 CZK, cost 6,800 CZK,
  open tasks 4, activities 3 and both integration warnings. Integrations exposed eight actual
  persisted observations. Finance displayed separate business/payment/accounting states.
- English Finance/navigation translated correctly. At 320px, document scroll width was 305px
  and the search input remained 173px wide. Document and the portalled account menu both computed
  the light scheme. At desktop size, header/sidebar top remained zero after scrolling 600px.
- Global header search navigated to the scoped search route, whose backend returns typed 503
  because the original Shell runtime installs `unavailableResourceGateways` (`api/index.ts:1144`
  and `:2009`, also present in `HEAD`). This inherited provider-gateway gap requires backend
  implementation and is not a passing search-result acceptance test.

Two current native-browser screenshots are saved under
`.codex/reports/review/siampark-storybook-ui/`: `finance-desktop.png` and `overview-desktop.png`.
The shared preview is on `/cs/siampark/finance` at port 3020. The native serve and composition
operators run as the user services `siampark-demo-serve` and `siampark-demo-composition` so they
survive the tool session. No demo reset, commit, push or GitHub issue mutation occurred during
this UI refinement. The earlier promotable-release build blocker remains unchanged.
