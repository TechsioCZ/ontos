import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem, Match } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { TaxActivationItemIdSchema } from '../../shared/domain/tax-activation-contracts.ts';
import { TAX_ACCEPTANCE_CLAIM, TAX_ACCEPTANCE_KEYS, taxAcceptanceLedger } from './tax-acceptance-ledger.ts';
import type { TaxAcceptanceRow, TestRef } from './tax-acceptance-ledger.ts';
import { TAX_FOREIGN_OWNER_DOUBLES } from './tax-evaluation-fixtures.ts';

const worktreeRoot = new URL('../../../../../', import.meta.url);
const issues = [961, 962, 963] as const;

/** Named tests a row relies on: its executed tests, or the guard of a NOT_APPLICABLE row. */
const referencedTests = (row: TaxAcceptanceRow): readonly TestRef[] =>
  Match.value(row.evidence).pipe(
    Match.discriminatorsExhaustive('kind')({
      GATED_NOT_EXECUTED: () => [],
      NOT_APPLICABLE: ({ guard }) => [guard],
      OWNER_KERNEL: ({ tests }) => tests,
      OWNER_PERSISTED: ({ tests }) => tests,
      SUPERSEDED: () => [],
    }),
  );

/** Keys whose meaning is TAX-owned persisted state (rules, the seller regime, finals, governance CAS). */
const persistenceKeys = new Set(['§3.1', '§3.2', '§3.3', '§3.4', '§6.1', '§6.2', '§6.3', '§6.4', '§6.5']);

describe('TAX acceptance ledger (#961-#963, D6)', () => {
  it('covers every closed coverage key of each issue and names no unknown key', () => {
    for (const issue of issues) {
      const rows = taxAcceptanceLedger.filter((row) => row.issue === issue);
      const covered = new Set(rows.flatMap(({ keys }) => keys));
      const expected = TAX_ACCEPTANCE_KEYS[issue];
      expect(
        expected.filter((key) => !covered.has(key)),
        `uncovered #${issue}`,
      ).toEqual([]);
      expect(
        [...covered].filter((key) => !expected.includes(key)),
        `unknown #${issue}`,
      ).toEqual([]);
      expect(new Set(expected).size).toBe(expected.length);
    }
  });

  it('#961 F22 D6 rows are never kernel-only and name only foreign-owner doubles', () => {
    expect(Object.values(TAX_FOREIGN_OWNER_DOUBLES).map(({ owner }) => owner)).not.toContain('TAX');
    for (const row of taxAcceptanceLedger) {
      const { evidence } = row;
      if (row.issue === 961) {
        expect(evidence.kind, row.id).not.toBe('OWNER_KERNEL');
      }
      if (evidence.kind === 'OWNER_PERSISTED') {
        // A persisted row rests on at least one Postgres-backed test.
        expect(
          evidence.tests.some(({ file }) => file.includes('/tests/integration/')),
          row.id,
        ).toBe(true);
      }
      if (evidence.kind === 'OWNER_KERNEL') {
        expect(
          row.keys.filter((key) => persistenceKeys.has(key)),
          row.id,
        ).toEqual([]);
      }
      if (evidence.kind === 'OWNER_KERNEL' || evidence.kind === 'OWNER_PERSISTED') {
        expect(
          evidence.doubles.filter((double) => !(double in TAX_FOREIGN_OWNER_DOUBLES)),
          row.id,
        ).toEqual([]);
      }
    }
  });

  it('#963 G gated rows run no test, name a non-TAX owner issue and keep PARK issues out of executed rows', () => {
    for (const row of taxAcceptanceLedger) {
      const { evidence } = row;
      if (evidence.kind === 'GATED_NOT_EXECUTED') {
        expect('tests' in evidence, row.id).toBe(false);
        expect(evidence.ownerIssue >= 918 && evidence.ownerIssue <= 964, row.id).toBe(false);
      } else {
        // #892 and #894 are PARK: they may only be named as the owner of a gated row.
        expect(JSON.stringify(row), row.id).not.toMatch(/#89[24]\b/u);
      }
    }
    expect(
      taxAcceptanceLedger
        .flatMap(({ evidence }) => (evidence.kind === 'GATED_NOT_EXECUTED' ? [evidence.ownerIssue] : []))
        .filter((ownerIssue) => ownerIssue === 892 || ownerIssue === 894)
        .toSorted((left, right) => left - right),
    ).toEqual([892, 894]);
    // #893 is the Pricing external-source route, not a TAX route.
    expect(JSON.stringify([taxAcceptanceLedger, TAX_FOREIGN_OWNER_DOUBLES])).not.toContain('893');
  });

  it('points every SUPERSEDED row at existing rows that are not superseded themselves', () => {
    const byId = new Map(taxAcceptanceLedger.map((row) => [row.id, row]));
    for (const row of taxAcceptanceLedger) {
      if (row.evidence.kind === 'SUPERSEDED') {
        for (const replacement of row.evidence.replacedBy) {
          expect(byId.get(replacement)?.evidence.kind, `${row.id} -> ${replacement}`).toBeDefined();
          expect(byId.get(replacement)?.evidence.kind, `${row.id} -> ${replacement}`).not.toBe('SUPERSEDED');
        }
      }
    }
  });

  it('keeps row ids unique and claims TAX owner acceptance only', () => {
    const ids = taxAcceptanceLedger.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TAX_ACCEPTANCE_CLAIM).toBe('TAX_OWNER_ACCEPTANCE_ONLY');
  });
});

it.layer(NodeFileSystem.layer)('TAX acceptance ledger checked-in tests', (suite) => {
  suite.effect('every mapped test file exists and contains its title verbatim', () =>
    Effect.gen(function* mappedTestsExist() {
      const fileSystem = yield* FileSystem.FileSystem;
      const references = taxAcceptanceLedger.flatMap((row) =>
        referencedTests(row).map((reference) => ({ ...reference, row: row.id })),
      );
      const files = [...new Set(references.map(({ file }) => file))];
      const sources = new Map(
        yield* Effect.forEach((file: (typeof files)[number]) =>
          fileSystem
            .readFileString(new URL(file, worktreeRoot).pathname)
            .pipe(Effect.map((text) => [file, text] as const)),
        )(files),
      );
      const missing = references.filter(({ file, title }) => sources.get(file)?.includes(`'${title}'`) !== true);
      expect(missing.map(({ file, row, title }) => `${row}: ${file} :: ${title}`)).toEqual([]);
    }),
  );

  suite.effect('#964 the acceptance doc lists exactly the activation item catalogue', () =>
    Effect.gen(function* activationDocMatchesCatalogue() {
      const fileSystem = yield* FileSystem.FileSystem;
      const doc = yield* fileSystem.readFileString(
        new URL('app/verticals/tax/tests/tax-acceptance.md', worktreeRoot).pathname,
      );
      const [, activationSection = ''] = doc.split('## #964 activation items');
      const documented = [...activationSection.matchAll(/^\| `(?<itemId>[A-Z0-9_]+)` +\|/gmu)].map(
        ({ groups }) => groups?.['itemId'],
      );
      expect(new Set(documented)).toEqual(new Set(TaxActivationItemIdSchema.literals));
      expect(documented).toHaveLength(TaxActivationItemIdSchema.literals.length);
    }),
  );
});
