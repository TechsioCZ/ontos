import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'effect-rstest';

import {
  EVIDENCE_LEVELS,
  PO_BLOCKERS,
  REQUIRED_TRACE_IDS,
  SANDBOX_NOT_APPLICABLE,
  SANDBOX_NOT_RUN,
  TRACE_TABLE_HEADER,
  TRACE_TEST_INDEX,
  TRACEABILITY,
  levelOf,
  traceTableCells,
  traceTestIndexCells,
} from '../support/psp-conformance-traceability.fixture.ts';

/**
 * #1159 executable traceability: every requirement of #1159 (minimum matrix, audit closure, mandatory negative/race
 * coverage), every gherkin scenario of #1153-#1159 and every plan section 6 level-3 scenario has a row; every cited
 * test exists with that exact title; every evidence level claim matches where its tests run; and the README table in
 * tests/acceptance/README.md states the same rows.
 */

const APP_ROOT = new URL('../../../../', import.meta.url);
const sourceOf = (file: string) => readFileSync(new URL(file, APP_ROOT), 'utf-8');
const README = readFileSync(new URL('../acceptance/README.md', import.meta.url), 'utf-8');

const MATRIX_FILE = 'verticals/payment/tests/unit/psp-conformance-matrix.test.ts';

const normalized = (cell: string) => cell.replaceAll(/\s+/gu, ' ').trim();

/** README table row of `id`, split into trimmed cells. */
const readmeCellsOf = (id: string) => {
  const line = README.split('\n').find((candidate) => candidate.startsWith(`| ${id} `));
  return line === undefined
    ? undefined
    : line.split(' | ').map((cell) => normalized(cell.replaceAll(/^\| |\|$/gu, '')));
};

describe('#1159 conformance traceability matrix', () => {
  it('#1159 every required requirement has exactly one row', () => {
    const ids = TRACEABILITY.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(REQUIRED_TRACE_IDS.length);
    expect(new Set(ids)).toEqual(new Set(REQUIRED_TRACE_IDS));
  });

  it('#1159 every cited test exists in its file with that exact title', () => {
    const missing = TRACEABILITY.flatMap((row) =>
      row.tests
        .filter(({ file, title }) => !sourceOf(file).includes(title))
        .map(({ file, title }) => `${row.id}: ${file} :: ${title}`),
    );
    expect(missing).toEqual([]);
    expect(TRACEABILITY.every(({ tests }) => tests.length > 0)).toBe(true);
  });

  it('#1159 each evidence level is derived from where its tests run, never from a description', () => {
    expect(levelOf({ file: 'verticals/payment/tests/integration/psp-executor-postgres.test.ts', title: '' })).toBe(
      'native',
    );
    expect(levelOf({ file: 'apps/shell-super-app/tests/integration/x.test.ts', title: '' })).toBe('native');
    expect(levelOf({ file: MATRIX_FILE, title: '' })).toBe('fixture');
    expect(levelOf({ file: 'verticals/payment/tests/unit/gopay-adapter.test.ts', title: '' })).toBe('fixture');
    expect(levelOf({ file: 'verticals/payment/tests/unit/psp-money.test.ts', title: '' })).toBe('unit');
    for (const row of TRACEABILITY) {
      expect(row.ran.length).toBeGreaterThan(0);
      expect(row.ran).toEqual(EVIDENCE_LEVELS.filter((level) => row.tests.some((test) => levelOf(test) === level)));
    }
  });

  it('#1159 no row claims sandbox evidence', () => {
    // Level 4 never ran: no sandbox credentials were present (plan N13). No row cites the sandbox suite as evidence.
    expect(TRACEABILITY.every(({ sandbox }) => sandbox === SANDBOX_NOT_RUN || sandbox === SANDBOX_NOT_APPLICABLE)).toBe(
      true,
    );
    expect(TRACEABILITY.flatMap(({ tests }) => tests).filter(({ file }) => file.includes('/tests/sandbox/'))).toEqual(
      [],
    );
    // Every row resting on the provider fixture matrix is a provider claim whose sandbox evidence is outstanding.
    expect(
      TRACEABILITY.filter(({ tests }) => tests.some(({ file }) => file === MATRIX_FILE))
        .filter(({ sandbox }) => sandbox !== SANDBOX_NOT_RUN)
        .map(({ id }) => id),
    ).toEqual([]);
  });

  it('#1159 the acceptance README states the same traceability rows', () => {
    expect(readmeCellsOf('ID')).toEqual(TRACE_TABLE_HEADER.map(normalized));
    const differing = TRACEABILITY.filter((row) => {
      const cells = readmeCellsOf(row.id);
      return cells === undefined || cells.join(' | ') !== traceTableCells(row).map(normalized).join(' | ');
    }).map(({ id }) => id);
    expect(differing).toEqual([]);
    const differingTests = TRACE_TEST_INDEX.filter((entry) => {
      const cells = readmeCellsOf(entry.key);
      return cells === undefined || cells.join(' | ') !== traceTestIndexCells(entry).map(normalized).join(' | ');
    }).map(({ key }) => key);
    expect(differingTests).toEqual([]);
  });

  it('#1159 the README names what is not proven and the conformance blockers returned to PO', () => {
    expect(README).toContain(SANDBOX_NOT_RUN);
    for (const blocker of PO_BLOCKERS) {
      expect(README).toContain(`**${blocker}**`);
    }
  });
});
