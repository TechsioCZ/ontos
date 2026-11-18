# Merging main into demo/sales-crm

## Procedure

One merge takes one pinned main commit into one pinned demo commit. It runs in a checkout of
`demo/sales-crm`, with the Git hooks on. History flows from main to demo only.

1. **Pin.** `git fetch origin main demo/sales-crm`, then `M=$(git rev-parse origin/main)` and
   `D=$(git rev-parse origin/demo/sales-crm)`. If `git rev-list --count $D..$M` prints 0, there is
   nothing to merge. Every later step names `$M` and `$D`, never the branches, so a push to either
   trunk during the merge changes nothing.
2. **Plan.** `node app/scripts/merge/plan.mts --main $M --demo $D --out <file>`. It needs `rerere` on in
   the clone and prints the command when it is off. Its summary says how
   many conflicts have a standing verdict and how many have `verdict: null`. Read `intents` (the
   incoming main pull requests, each `clean`, `conflicted` or `adapt`), `conflicts`, the migration
   lists and the new import edges before touching the tree.
3. **Merge.** At `$D`: `git merge --no-ff --no-commit $M`. Resolve every conflict that has a verdict
   exactly as its row says. For a conflict with `verdict: null`, open the pull request of the intent
   that lists the path and read the line "Next main-to-demo merge" in its description. Where that
   line settles the path, follow it. Otherwise decide part by part which side solves the problem
   better: main is the engineered line and demo is ahead in places, so neither side wins by default.
   Never resolve with a strategy option (`-X ours`, `-X theirs`), and never take a whole conflicted
   file from one side when the row or the pull request names hunks.
4. **Lockfile.** Follow V8.
5. **Commit.** The message names `$M` and `$D`, every `verdict: null` conflict with the side taken
   and why, and every main hunk ported by hand. The pre-commit hook lints the merged files and the
   pre-push hook runs the typecheck and the contract check. Both stay on (`lefthook.yml`); a hook
   that fails names a defect of the merge result.
6. **Candidate.** `git push origin HEAD:refs/heads/candidate/main-merge-<yyyymmdd>`. The push starts
   Merge Adaptation Check. Start the gates for the same branch:
   `gh workflow run ultramodern-workspace-gates.yml --ref candidate/main-merge-<yyyymmdd> -f base-ref=demo/sales-crm -f keep=true`.
   Fix what they report on the candidate and push again until both are green. V5 to V7 say how to
   fix the preflight findings. An `authorization-catalog-stale` finding is fixed by
   `pnpm authorization:catalog:artifact` (from `app/`) and committing the result.
7. **Promote.** `git fetch origin demo/sales-crm`. If demo is still `$D`, push the proven commit:
   `git push origin HEAD:demo/sales-crm`. If demo moved, merge its new tip into the candidate with
   `git merge origin/demo/sales-crm` (a merge, so the proven merge commit stays in the history). When
   that merge is clean and brings no file the main side changed, push to demo; the trunk's own gates
   cover it. Otherwise push the candidate and wait for Merge Adaptation Check again.
8. **Done.** The Zerops Stage Deploy run of that push is green and
   `git merge-base --is-ancestor $M origin/demo/sales-crm` succeeds. Then delete the candidate:
   `git push origin --delete candidate/main-merge-<yyyymmdd>`.

A main pull request that changes a file demo also carries says in its description what the next merge
does with it. When that rule is the same for every later merge, it becomes a row below in the same
push that lands the merge.

## Standing verdicts

`node app/scripts/merge/plan.mts` reads the table below and attaches the first matching row to every
conflict in the plan. A row matches when one of its path globs matches the conflicted path and one of
its kinds admits the conflict: `any`, a conflict kind (`content`, `modify-delete`, `add-add`,
`rename`, `other`), or `demo-deleted`, which admits a modify/delete where demo deleted the file and
`git grep` of the file's name on the merge result tree finds no other file that names it, conflicted
files included. A conflict no row matches gets `verdict: null`. Those are the only conflicts a person or a model decides. Rows
without globs apply to the merge preflight findings and to the plan's migration lists, not to
conflicts.

Everything under `app/verticals/*/src` or `app/verticals/*/shared` that conflicts is always
`verdict: null`, whatever row would match it.

The plan reads this table from pinned demo, and from the checkout only while demo has no copy yet. A
missing marker, a row that is not `| V<n> | globs | kinds | verdict |`, a duplicate id or an unknown kind
stops the plan; `app/scripts/merge/plan.test.mts` proves this file on every push that changes it.

<!-- verdicts:start -->

| Id  | Paths                                                                                                                                                                                                                                                                                                                                                                                        | Kinds            | Verdict                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V1  | `.github/workflows/ultramodern-workspace-gates.yml`, `.github/workflows/quality-audit.yml`, `.github/actions/install-app/action.yml`, `app/scripts/plan-ci-*`, `app/scripts/ci/**`, `app/scripts/ci-matrices.json`, `app/scripts/check-ci-gates.sh`, `app/scripts/tests/ci-*.test.mts`, `app/apps/shell-super-app/playwright.config.ts`                                                      | any              | Demo CI: keep demo's side. Port a main hunk by hand only when its intent fixes a command demo also runs, and name it in the merge message.                                                                                                                                           |
| V2  | `**`, `.github/**`                                                                                                                                                                                                                                                                                                                                                                           | demo-deleted     | Demo deleted the file and nothing on the result tree names it: keep it deleted.                                                                                                                                                                                                      |
| V3  | `app/docs/architecture/DEPLOYMENT.md`, `app/zerops.yaml`, `app/scripts/zerops/**`                                                                                                                                                                                                                                                                                                            | any              | Demo deployment: keep demo's side.                                                                                                                                                                                                                                                   |
| V4  | `app/scripts/tests/external-dependency-config.test.mts`                                                                                                                                                                                                                                                                                                                                      | any              | Keep demo's side: the demo gates workflow declares the PostgreSQL proof service.                                                                                                                                                                                                     |
| V5  | —                                                                                                                                                                                                                                                                                                                                                                                            | —                | Every MCP reads, commands or actions finding becomes `OntosMcpHidden` in that owner's `shared/mcp/contribution.ts` with the comment `// Introduced by main #<pr>; hidden until its agent tool text is designed.`                                                                     |
| V6  | —                                                                                                                                                                                                                                                                                                                                                                                            | —                | A reviewed-role cell is never added by a merge. `unreviewed` and `withdrawn` cells in the preflight report are information for a person: list them in the merge message and change neither `app/scripts/demo/reviewed-people-cells.mts` nor a role policy.                           |
| V7  | —                                                                                                                                                                                                                                                                                                                                                                                            | —                | Take main's added drizzle folders verbatim. Every `migrationEdits` or `interleavedMigrations` entry is decided by a person and blocks promotion until then.                                                                                                                          |
| V8  | `app/pnpm-lock.yaml`                                                                                                                                                                                                                                                                                                                                                                         | any              | Never merge the lockfile: take demo's side, run `pnpm install` on the merge result and commit the regenerated lockfile.                                                                                                                                                              |
| V9  | `app/pnpm-workspace.yaml`                                                                                                                                                                                                                                                                                                                                                                    | content          | Keep demo's side of the `patchedDependencies` tail: demo's own patch entries, which main does not carry. Main's hunks elsewhere merge clean.                                                                                                                                         |
| V10 | `app/verticals/assortment/package.json`, `app/verticals/privacy/package.json`, `app/verticals/projects/package.json`                                                                                                                                                                                                                                                                         | content          | Take main's version values (`tsrs`, `@effect/tsgo`) and keep demo's deletion of `wrangler` and demo's added dependencies (privacy's `@app/party-registry-identity-contracts`). These conflict again whenever main touches the lines next to them, until main removes `wrangler` too. |
| V11 | `app/packages/core-runtime/src/modules/active-application-composition-source.workerd.ts`                                                                                                                                                                                                                                                                                                     | content          | Keep demo's side: demo reads the snapshot as one `arrayBuffer` in a request-scoped Layer, so main's edits to the stream read (#1493 rewrote its abort cancel) have no code to apply to.                                                                                              |
| V12 | `app/verticals/catalog/vertical.manifest.ts`, `app/verticals/catalog/vertical.registration.ts`, `app/verticals/catalog/vertical.runtime-declaration.ts`, `app/verticals/catalog/api/index.ts`, `app/verticals/privacy/vertical.manifest.ts`, `app/verticals/privacy/vertical.registration.ts`, `app/verticals/privacy/vertical.runtime-declaration.ts`, `app/verticals/privacy/api/index.ts` | content, add-add | Keep demo's side of each conflicting hunk: what still differs after main #1491 and #1492 is demo's own (owner approvals, demo pages, Search). Main's other hunks merge clean; never take the whole file from one side.                                                               |
| V13 | `app/scripts/install-zerops-node.sh`                                                                                                                                                                                                                                                                                                                                                         | modify-delete    | Keep demo's deletion: demo runs on native Node images and pins the Node version in `app/.mise.toml` and `app/zerops.yaml` (V3).                                                                                                                                                      |
| V14 | `app/scripts/ops/stage-operations.mts`                                                                                                                                                                                                                                                                                                                                                       | modify-delete    | Keep demo's file: main deleted its retired stage provisioning (#1488), and demo keeps this script as its own overlay.                                                                                                                                                                |

<!-- verdicts:end -->

## Adaptation preflight

`node scripts/merge/adaptation-check.mts --base <demo commit>` (from `app/`) runs on every `candidate/**`
push. A clean report proves that every vertical's contract derives, that every registered-workload call
matches the reviewed inventory and its receiver, that the committed authorization catalog is current, and
that the reviewed roles compile; unreviewed cells are listed for a person to decide. It does not prove the node build: a Shell or app
import that needs a new package export, and whether a new read or Action is registered in its owner's
runtime declaration, are left to the gates.

Derivation is not read-only. It bundles each owner's source with esbuild into scoped `.ontos-contract-*`
directories under that vertical and removes them when it finishes.
