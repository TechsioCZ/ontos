import { readFileSync } from 'node:fs';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { parseVerdicts } from './plan.mts';

/** The table the plan reads: a push that changes only this document runs these tests and nothing else. */
const MERGING = readFileSync(new URL('../../docs/architecture/MERGING.md', import.meta.url), 'utf-8');
const START = '<!-- verdicts:start -->';
const END = '<!-- verdicts:end -->';
const HEADER = ['| Id | Paths | Kinds | Verdict |', '| --- | --- | --- | --- |'];

const table = (...rows: readonly string[]) => [START, '', ...HEADER, ...rows, '', END].join('\n');
const ROW = '| V1 | `app/x.ts` | any | Keep demo. |';
const FOUR_CELLS = 'four cells';
const GLOBS_AND_KINDS = 'both path globs and kinds';
/** Why the plan refuses this document. */
const failure = (document: string) =>
  parseVerdicts(document).pipe(
    Effect.flip,
    Effect.map(({ message }) => message),
  );

it.effect('reads every row of the real verdict table', () =>
  Effect.gen(function* readRealTable() {
    const rules = yield* parseVerdicts(MERGING);
    const rows = MERGING.slice(MERGING.indexOf(START), MERGING.indexOf(END))
      .split('\n')
      .filter((line) => /^\|\s*V\d+\s*\|/u.test(line));
    // Every row of the document is a rule: none is dropped.
    expect(rules.map(({ id }) => id)).toEqual(rows.map((line) => line.split('|')[1]?.trim()));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.rule.length, rule.id).toBeGreaterThan(0);
      expect(rule.globs.length === 0, rule.id).toBe(rule.kinds.length === 0);
    }
  }),
);

it.effect('rejects a table without its start or end marker', () =>
  Effect.gen(function* rejectMarkers() {
    expect(yield* failure(table(ROW).replace(START, ''))).toContain(START);
    expect(yield* failure(table(ROW).replace(END, ''))).toContain(END);
    expect(yield* failure(`${END}\n${table(ROW).replace(END, '')}`)).toContain(END);
    expect(yield* failure(MERGING.replace(START, ''))).toContain(START);
    expect(yield* failure(MERGING.replace(END, ''))).toContain(END);
    expect(yield* failure(table())).toContain('declares no verdict');
  }),
);

it.effect('rejects a row that does not parse into an id, path globs, kinds and a verdict', () =>
  Effect.gen(function* rejectRows() {
    expect(yield* failure(table('| V1 | `app/x.ts` | any |'))).toContain(FOUR_CELLS);
    expect(yield* failure(table('| V1 | `app/x.ts` | any | Keep demo. | extra |'))).toContain(FOUR_CELLS);
    expect(yield* failure(table('V1 | `app/x.ts` | any | Keep demo. |'))).toContain(FOUR_CELLS);
    expect(yield* failure(table('Stray prose inside the table.'))).toContain(FOUR_CELLS);
    expect(yield* failure(table('| X1 | `app/x.ts` | any | Keep demo. |'))).toContain('"X1"');
    expect(yield* failure(table('| V1 | `app/x.ts` | any |  |'))).toContain('no verdict text');
    expect(yield* failure(table('| V1 | `app/x.ts` | — | Keep demo. |'))).toContain(GLOBS_AND_KINDS);
    expect(yield* failure(table('| V1 | — | content | Keep demo. |'))).toContain(GLOBS_AND_KINDS);
  }),
);

it.effect('rejects a duplicate id and an unknown kind', () =>
  Effect.gen(function* rejectIdsAndKinds() {
    expect(yield* failure(table(ROW, '| V1 | `app/y.ts` | content | Keep main. |'))).toContain('V1 is declared twice');
    expect(yield* failure(table('| V1 | `app/x.ts` | content, modify/delete | Keep demo. |'))).toContain(
      'unknown kinds modify/delete',
    );
  }),
);

it.effect('reads globs, kinds and preflight rows the way the plan matches them', () =>
  Effect.gen(function* readRows() {
    const rules = yield* parseVerdicts(
      table(
        '| V1 | `app/x.ts`, `app/y/**` | content, add-add | Keep demo. |',
        '| V2 | — | — | A preflight rule. |',
        '| V3 | `**` | demo-deleted | Keep it deleted. |',
      ),
    );
    expect(rules).toEqual([
      { globs: ['app/x.ts', 'app/y/**'], id: 'V1', kinds: ['content', 'add-add'], rule: 'Keep demo.' },
      { globs: [], id: 'V2', kinds: [], rule: 'A preflight rule.' },
      { globs: ['**'], id: 'V3', kinds: ['demo-deleted'], rule: 'Keep it deleted.' },
    ]);
  }),
);
