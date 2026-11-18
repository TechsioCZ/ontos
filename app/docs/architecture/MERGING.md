# Merging main into demo/sales-crm

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

The plan reads this table from pinned demo, and from the checkout only while demo has no copy yet.

<!-- verdicts:start -->

| Id  | Paths                                                                                                                                                                                                                                                                                                                                   | Kinds        | Verdict                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | `.github/workflows/ultramodern-workspace-gates.yml`, `.github/workflows/quality-audit.yml`, `.github/actions/install-app/action.yml`, `app/scripts/plan-ci-*`, `app/scripts/ci/**`, `app/scripts/ci-matrices.json`, `app/scripts/check-ci-gates.sh`, `app/scripts/tests/ci-*.test.mts`, `app/apps/shell-super-app/playwright.config.ts` | any          | Demo CI: keep demo's side. Port a main hunk by hand only when its intent fixes a command demo also runs, and name it in the merge message.                                                                       |
| V2  | `**`, `.github/**`                                                                                                                                                                                                                                                                                                                      | demo-deleted | Demo deleted the file and nothing on the result tree names it: keep it deleted.                                                                                                                                  |
| V3  | `app/docs/architecture/DEPLOYMENT.md`, `app/zerops.yaml`, `app/scripts/zerops/**`                                                                                                                                                                                                                                                       | any          | Demo deployment: keep demo's side.                                                                                                                                                                               |
| V4  | `app/scripts/tests/external-dependency-config.test.mts`                                                                                                                                                                                                                                                                                 | any          | Keep demo's side: the demo gates workflow declares the PostgreSQL proof service.                                                                                                                                 |
| V5  | —                                                                                                                                                                                                                                                                                                                                       | —            | Every MCP reads, commands or actions finding becomes `OntosMcpHidden` in that owner's `shared/mcp/contribution.ts` with the comment `// Introduced by main #<pr>; hidden until its agent tool text is designed.` |
| V6  | —                                                                                                                                                                                                                                                                                                                                       | —            | A reviewed-role cell finding adds the key to that role's list in `reviewedExclusions` (`app/scripts/demo/reviewed-people-plan.mts`) and updates the pinned exclusion counts. Never add a cell.                   |
| V7  | —                                                                                                                                                                                                                                                                                                                                       | —            | Take main's added drizzle folders verbatim. Every `migrationEdits` or `interleavedMigrations` entry is decided by a person and blocks promotion until then.                                                      |

<!-- verdicts:end -->

## Adaptation preflight

`node scripts/merge/adaptation-check.mts --base <demo commit>` (from `app/`) runs on every `candidate/**`
push. A clean report proves that every vertical's contract derives, that every registered-workload call
matches the reviewed inventory and its receiver, that the committed authorization catalog is current, and
that the reviewed roles compile without unreviewed growth. It does not prove the node build: a Shell or app
import that needs a new package export, and whether a new read or Action is registered in its owner's
runtime declaration, are left to the gates.

Derivation is not read-only. It bundles each owner's source with esbuild into scoped `.ontos-contract-*`
directories under that vertical and removes them when it finishes.
