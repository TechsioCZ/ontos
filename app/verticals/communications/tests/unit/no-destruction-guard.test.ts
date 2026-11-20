import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'effect-rstest';

import { communicationsManifest } from '../../vertical.manifest.ts';
import { outboxWorkers } from '../../src/workers/index.ts';
import { scanMigrationForDestruction, scanSourceForDestruction } from '../support/no-destruction-scan.ts';
import type { DestructionFinding } from '../support/no-destruction-scan.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

const filesUnder = (directory: string, suffix: RegExp): readonly string[] =>
  readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && suffix.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));

const ownerSources = [
  ...filesUnder('src', /\.ts$/u),
  ...filesUnder('shared', /\.ts$/u),
  ...filesUnder('api', /\.ts$/u),
  ...filesUnder('scripts', /\.mts$/u),
  ...filesUnder('tests/support', /\.ts$/u),
  'vertical.manifest.ts',
  'vertical.registration.ts',
];

const scanFile = (file: string) => scanSourceForDestruction(file, readFileSync(path.join(root, file), 'utf-8'));

interface Allowance {
  readonly file: string;
  readonly kind: RegExp;
  readonly occurrences: number;
  readonly reason: string;
  readonly text: RegExp;
}

/**
 * The only destructive or rewriting statements that exist, each with the reason it is not a D21 disposal path. A new entry needs
 * the same review: no entry may touch a personal-data category of the inventory.
 */
const allowedMutations: readonly Allowance[] = [
  {
    file: 'src/auth/gateway-assertion-redemption-runtime.ts',
    kind: /^access to \.delete$/u,
    occurrences: 1,
    reason:
      'generated replay protection of the gateway assertion ledger: issuer, audience and jti only, no subject, actor or message data',
    text: /\.delete\(gatewayAssertionRedemptions\)/u,
  },
  {
    file: 'src/services/template-revision.service.ts',
    kind: /^access to \.update$/u,
    occurrences: 1,
    reason:
      'closes ONE activation period once (a trigger refuses any later change), so closed template history stays append-only',
    text: /\.update\(templateActivations\)/u,
  },
];

/** Findings the allowlist does not cover. An entry covers at most its own `occurrences`, so a second statement is flagged. */
const unallowed = (file: string, findings: readonly DestructionFinding[], allowances: readonly Allowance[]) => {
  const used = new Map<Allowance, number>();
  return findings.filter(({ kind, text }) => {
    const entry = allowances.find(
      (candidate) =>
        candidate.file === file &&
        candidate.kind.test(kind) &&
        candidate.text.test(text) &&
        (used.get(candidate) ?? 0) < candidate.occurrences,
    );
    if (entry === undefined) {
      return true;
    }
    used.set(entry, (used.get(entry) ?? 0) + 1);
    return false;
  });
};

/**
 * Migration statements that are not a plain create: each is a reviewed, pre-release or non-personal change. Nothing here
 * deletes a record of a personal-data category.
 */
const allowedMigrationStatements: readonly Allowance[] = [
  {
    file: 'drizzle/20261119100821_enforce-communications-grants/migration.sql',
    kind: /^SQL GRANT/u,
    occurrences: 1,
    reason: 'DELETE on the gateway assertion ledger only (issuer, audience and jti; no personal data)',
    text: /delete on table "communications"\."gateway_assertion_redemptions"/iu,
  },
  {
    file: 'drizzle/20261119111427_enforce-template-revision-grants/migration.sql',
    kind: /^SQL GRANT/u,
    occurrences: 1,
    reason: 'column-level UPDATE that closes ONE template activation period; a trigger refuses any later change',
    text: /update \("ended_at"[^)]*\) on table "communications"\."template_activations"/iu,
  },
  {
    file: 'drizzle/20261119122651_template-revision-hardening/migration.sql',
    kind: /^raw SQL UPDATE$/u,
    occurrences: 1,
    reason: 'pre-release #1398 backfill of two placeholder columns of the template revision, before any release',
    text: /update "communications"\."template_revisions"/iu,
  },
  {
    file: 'drizzle/20261119122651_template-revision-hardening/migration.sql',
    kind: /^raw SQL DROP$/u,
    occurrences: 2,
    reason: 'pre-release #1398 removal of two never-used placeholder columns of the template TYPE, before any release',
    text: /drop column/iu,
  },
  {
    file: 'drizzle/20261119151603_enforce-communication-intake/migration.sql',
    kind: /^raw SQL UPDATE$/u,
    occurrences: 1,
    reason: 'the one finishing write of a PREPARED delivery attempt; the append-only trigger refuses any later change',
    text: /update "communications"\."delivery_attempts" set/iu,
  },
  {
    file: 'drizzle/20261119170404_enforce-handoff-evaluations/migration.sql',
    kind: /^raw SQL UPDATE$/u,
    occurrences: 1,
    reason: 'the same single finishing write, re-declared by the handoff evaluation routine',
    text: /update "communications"\."delivery_attempts" set/iu,
  },
];

describe('No automatic destructive mechanism (#1410 AC-05 AC-12, PRIV-COM-05/06/16, E)', () => {
  it('has no delete, update, upsert, purge, anonymize, cleanup, timer or scheduler in any owner source, script or test support, except the two reviewed non-personal ones', () => {
    expect(ownerSources.length).toBeGreaterThan(50);
    const offenders = ownerSources.flatMap((file) =>
      unallowed(file, scanFile(file), allowedMutations).map(
        ({ kind, line, text }) => `${file}:${line} ${kind}: ${text}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('allows no mutation on a personal-data table: every allowed statement targets a table with no personal data', () => {
    for (const { reason } of [...allowedMutations, ...allowedMigrationStatements]) {
      expect(reason.length).toBeGreaterThan(20);
    }
    expect(allowedMutations.map(({ file }) => file).toSorted()).toEqual([
      'src/auth/gateway-assertion-redemption-runtime.ts',
      'src/services/template-revision.service.ts',
    ]);
    // each allowed source statement really exists once: an entry that no longer matches must be deleted, not kept as cover
    for (const { file, occurrences } of allowedMutations) {
      expect(scanFile(file).length, file).toBeGreaterThanOrEqual(occurrences);
    }
  });

  it('has no UPDATE, DELETE, TRUNCATE, DROP or row-changing GRANT in any migration outside the reviewed statements', () => {
    const migrations = filesUnder('drizzle', /migration\.sql$/u);
    expect(migrations.length).toBeGreaterThan(0);
    const offenders = migrations.flatMap((file) =>
      unallowed(
        file,
        scanMigrationForDestruction(readFileSync(path.join(root, file), 'utf-8')),
        allowedMigrationStatements,
      ).map(({ kind, line, text }) => `${file}:${line} ${kind}: ${text}`),
    );
    expect(offenders).toEqual([]);
    // the reviewed entries still exist: a stale allowance is not kept as cover
    for (const { file, occurrences } of allowedMigrationStatements) {
      const found = unallowed(file, scanMigrationForDestruction(readFileSync(path.join(root, file), 'utf-8')), []);
      expect(found.length, file).toBeGreaterThanOrEqual(occurrences);
    }
  });

  it('exposes no Action whose key or verb can dispose of data: the only Actions are the existing template, language and intake ones', () => {
    const keys = communicationsManifest.publicSurface.actions.map((action) => action.descriptor.actionKey);
    expect(
      keys.filter((key) => /(?:delete|purge|anonymi[sz]e|erase|shred|wipe|cleanup|dispos|retention|dsr)/iu.test(key)),
    ).toEqual([]);
  });

  it('registers exactly one worker, the pre-handoff worker: no expiry, retention, cleanup or disposition worker exists', () => {
    expect(outboxWorkers.map((worker) => worker.descriptor.workerKey)).toEqual([
      'communications.core.prepare-message-handoff',
    ]);
  });

  it('keeps the retention hook and the owner contract free of any write capability', () => {
    for (const file of filesUnder('shared/privacy-owner', /\.ts$/u)) {
      const source = readFileSync(path.join(root, file), 'utf-8');
      expect(scanFile(file), file).toEqual([]);
      expect(/from 'drizzle-orm|ScopedTransactionExecutor|\.insert\(/u.test(source), file).toBe(false);
    }
    expect(scanFile('src/domain/retention/anti-resurrection-guard.ts')).toEqual([]);
    expect(
      /\.insert\(|\.execute\(/u.test(
        readFileSync(path.join(root, 'src/domain/retention/anti-resurrection-guard.ts'), 'utf-8'),
      ),
    ).toBe(false);
  });
});

/**
 * Negative controls: every bypass a reviewer listed against the earlier regex guard, plus the shapes a regex cannot read, must
 * now be found by the AST scan. Each fixture is source TEXT that is parsed and never executed.
 */
const kindsOf = (source: string): readonly string[] =>
  scanSourceForDestruction('fixture.ts', source).map(({ kind }) => kind);
const kinds = (sql: string): readonly string[] => scanMigrationForDestruction(sql).map(({ kind }) => kind);
/** A template placeholder written without a literal `${`, which a plain string would otherwise look like a mistake. */
const DOLLAR = String.fromCodePoint(36);

describe('The guard catches what a text search missed (negative controls)', () => {
  const caught: readonly (readonly [string, string, RegExp])[] = [
    ['a computed string member', "await db['delete'](people);", /access to \.delete/u],
    ['a folded string member', "await db['del' + 'ete'](people);", /access to \.delete/u],
    ['a template-literal member', 'await db[`update`](people);', /access to \.update/u],
    ['an optional-chained member', 'await db?.update(people);', /access to \.update/u],
    ['a truncate member', 'await db.truncate(people);', /access to \.truncate/u],
    ['an alias of the delete member', 'const remove = db.delete;\nawait remove(people);', /access to \.delete/u],
    ['a destructured delete', 'const { delete: remove } = db;', /destructured \.delete/u],
    ['a shorthand destructured update', 'const { update } = db;', /destructured \.update/u],
    [
      'a destructured function parameter',
      'const run = ({ update }: Database) => update(people);',
      /destructured \.update/u,
    ],
    [
      'an upsert',
      'await db.insert(people).values(row).onConflictDoUpdate({ target: people.id, set: row });',
      /access to \.onConflictDoUpdate/u,
    ],
    ['a raw UPDATE in a tagged template', `await sql\`UPDATE people SET name = ${DOLLAR}{name}\`;`, /raw SQL UPDATE/u],
    [
      'a raw UPDATE with a schema and an interpolated table',
      `await sql\`update "s".${DOLLAR}{table} set a = 1\`;`,
      /raw SQL UPDATE/u,
    ],
    ['a raw DELETE in a plain string', "await client.query('DELETE FROM people');", /raw SQL DELETE/u],
    ['a raw DELETE split over a concatenation', "await client.query('DEL' + 'ETE FROM people');", /raw SQL DELETE/u],
    ['a raw TRUNCATE without TABLE', 'await sql`TRUNCATE people`;', /raw SQL TRUNCATE/u],
    ['a raw TRUNCATE TABLE', 'await sql`truncate table people`;', /raw SQL TRUNCATE/u],
    ['a raw DROP TABLE', 'await sql`DROP TABLE people`;', /raw SQL DROP/u],
    [
      'a raw DROP SCHEMA through sql.raw',
      "await db.execute(sql.raw('drop schema if exists communications cascade'));",
      /raw SQL DROP/u,
    ],
    ['a raw DROP COLUMN', 'await sql`ALTER TABLE people DROP COLUMN email`;', /raw SQL DROP/u],
    ['Effect.repeat', 'const loop = Effect.repeat(work, schedule);', /scheduling \.repeat/u],
    [
      'an aliased Effect namespace',
      "import * as E from 'effect/Effect';\nconst loop = E.forever(work);",
      /scheduling \.forever/u,
    ],
    ['a destructured repeat', 'const { repeat } = Effect;', /destructured scheduling \.repeat/u],
    ['an import of Schedule', "import { Schedule } from 'effect';", /import of Schedule/u],
    ['an aliased import of Schedule', "import { Schedule as Every } from 'effect';", /import of Schedule/u],
    ['a direct Schedule module import', "import * as Every from 'effect/Schedule';", /import of effect\/Schedule/u],
    ['a direct Cron module import', "import * as Cron from 'effect/Cron';", /import of effect\/Cron/u],
    ['a named repeat import', "import { repeat as again } from 'effect/Effect';", /import of scheduling repeat/u],
    ['setInterval', 'setInterval(work, 1000);', /timer setInterval/u],
    ['globalThis.setTimeout', 'globalThis.setTimeout(work, 1000);', /timer \.setTimeout/u],
    ['a disposal call', 'await purgeExpiredMessages();', /disposal call purgeExpiredMessages/u],
    ['a disposal method', 'await store.anonymizeRecipients();', /disposal call anonymizeRecipients/u],
    [
      'code after a string that contains an opening comment marker',
      "const note = '/* not a comment';\nawait db.delete(people);\nconst end = '*/';",
      /access to \.delete/u,
    ],
    [
      'code after a line comment marker inside a string',
      "const url = 'https://example.test'; await db.update(people);",
      /access to \.update/u,
    ],
  ];

  for (const [name, source, expected] of caught) {
    it(`finds ${name}`, () => {
      expect(
        kindsOf(source).some((kind) => expected.test(kind)),
        `${source} -> ${kindsOf(source).join(', ')}`,
      ).toBe(true);
    });
  }

  it('ignores prose and commented-out code, which explain the prohibition without performing anything', () => {
    expect(
      kindsOf(
        [
          '// db.delete(people) is never called',
          '/* UPDATE people SET name = 1; setInterval(work) */',
          "const message = 'we update the label and delete nothing';",
          "const other = new Map<string, number>().get('delete');",
          'const copy = { delete: 1, update: 2 };',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('covers a statement count: a second allowed-looking statement in the same file is not covered by the first', () => {
    const findings = scanSourceForDestruction(
      'src/auth/gateway-assertion-redemption-runtime.ts',
      'await db.delete(gatewayAssertionRedemptions);\nawait db.delete(gatewayAssertionRedemptions);',
    );
    expect(unallowed('src/auth/gateway-assertion-redemption-runtime.ts', findings, allowedMutations)).toHaveLength(1);
  });

  it('finds every destructive migration statement, including DML hidden in a function body and a grant', () => {
    expect(kinds('UPDATE "s"."t" SET "a" = 1 WHERE "id" = 2;')).toEqual(['raw SQL UPDATE']);
    expect(kinds('CREATE FUNCTION f() RETURNS void AS $$ BEGIN\n  DELETE FROM "s"."t";\nEND $$;')).toEqual([
      'raw SQL DELETE',
    ]);
    expect(kinds('TRUNCATE "s"."t";')).toEqual(['raw SQL TRUNCATE']);
    expect(kinds('TRUNCATE TABLE "s"."t";')).toEqual(['raw SQL TRUNCATE']);
    expect(kinds('DROP TABLE "s"."t";')).toEqual(['raw SQL DROP']);
    expect(kinds('ALTER TABLE "s"."t" DROP COLUMN "c";')).toEqual(['raw SQL DROP']);
    expect(kinds('GRANT SELECT, DELETE ON TABLE "s"."t" TO "ontos_runtime";')).toEqual([
      'SQL GRANT of a row-changing privilege',
    ]);
    expect(kinds('GRANT UPDATE ("c") ON TABLE "s"."t" TO "ontos_runtime";')).toEqual([
      'SQL GRANT of a row-changing privilege',
    ]);
    // harmless forms stay quiet: policies, triggers, locks and constraint changes name the verbs without performing them
    expect(
      kinds(
        [
          'CREATE POLICY "p" ON "s"."t" AS PERMISSIVE FOR UPDATE TO "ontos_runtime" USING (true);',
          'CREATE TRIGGER "x" BEFORE UPDATE OR DELETE ON "s"."t" FOR EACH ROW EXECUTE FUNCTION f();',
          'SELECT 1 FROM "s"."t" FOR UPDATE;',
          'ALTER TABLE "s"."t" DROP CONSTRAINT "c";',
          '-- UPDATE "s"."t" SET a = 1 and DROP TABLE x are only prose here',
          '/* DELETE FROM t */ SELECT 1;',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});
