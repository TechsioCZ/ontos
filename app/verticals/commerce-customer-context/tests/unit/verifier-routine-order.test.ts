import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

import { Array as EffectArray, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

const source = readFileSync(new URL('../../scripts/verify-db-schema.mts', import.meta.url), 'utf-8');
const parsed = parseSync('verify-db-schema.mts', source);

// Execute the verifier's private declarations without importing its database-running entrypoint.
const declaration = (name: string): string => {
  const statement = parsed.program.body.find(
    (entry) =>
      entry.type === 'VariableDeclaration' &&
      entry.declarations.some(
        (entryDeclaration) => entryDeclaration.id.type === 'Identifier' && entryDeclaration.id.name === name,
      ),
  );
  if (statement === undefined) {
    throw new Error(`Missing verifier declaration: ${name}`);
  }
  return source.slice(statement.start, statement.end);
};

const executable = stripTypeScriptTypes(
  [declaration('EXPECTED_RUNTIME_ROUTINES'), declaration('sameStrings')].join('\n'),
);
const executeDeclarations = (expression: string): string =>
  execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', `${executable}\nprocess.stdout.write(JSON.stringify(${expression}));`],
    { encoding: 'utf-8' },
  );
const expected = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
  JSON.parse(executeDeclarations('EXPECTED_RUNTIME_ROUTINES')),
);
const compare = (actual: readonly string[]): boolean =>
  Schema.decodeUnknownSync(Schema.Boolean)(
    JSON.parse(executeDeclarations(`sameStrings(${JSON.stringify(actual)}, EXPECTED_RUNTIME_ROUTINES)`)),
  );
const sqlOrdered = EffectArray.sort(expected, Order.String);

it('accepts the complete SQL-ordered runtime routine set through the verifier comparator', () => {
  expect(parsed.errors).toEqual([]);
  expect(source).toContain('array_agg(routine.proname::text order by routine.proname)');
  expect(source).toContain('!sameStrings(row.runtime_routines, EXPECTED_RUNTIME_ROUTINES)');
  expect(source).toContain('row.routine_count !== EXPECTED_RUNTIME_ROUTINES.length');
  expect(expected).toHaveLength(129);
  expect(new Set(expected).size).toBe(129);
  expect(compare(sqlOrdered)).toBe(true);
});

it('rejects missing, duplicate, unexpected, and substituted runtime routines', () => {
  expect(compare(sqlOrdered.slice(1))).toBe(false);
  expect(compare(EffectArray.sort([sqlOrdered[1], ...sqlOrdered.slice(1)], Order.String))).toBe(false);
  expect(compare(EffectArray.sort([...sqlOrdered, 'unexpected_runtime_routine'], Order.String))).toBe(false);
  expect(compare(EffectArray.sort(['wrong_runtime_routine', ...sqlOrdered.slice(1)], Order.String))).toBe(false);
});
