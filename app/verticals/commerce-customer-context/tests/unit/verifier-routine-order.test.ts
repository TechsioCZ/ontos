import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
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

// Independently account for the shipped explicit GRANT/DROP signatures. This is a source contract
// check, not execution of migrations or a substitute for the native verifier's privilege checks.
const shippedRuntimeRoutines = () => {
  const directory = new URL('../../drizzle/', import.meta.url);
  const signatures = new Map<string, string>();
  const migrations = EffectArray.sort(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name),
    Order.String,
  );
  for (const migration of migrations) {
    const sql = readFileSync(new URL(`${migration}/migration.sql`, directory), 'utf-8');
    const declarations =
      /(?<operation>GRANT\s+EXECUTE\s+ON\s+FUNCTION|DROP\s+FUNCTION(?:\s+IF\s+EXISTS)?)\s+"?commerce_customer_context"?\."?(?<name>[a-z0-9_]+)"?\((?<parameters>[^)]*)\)(?:\s+TO\s+"?(?<role>[a-z_]+)"?)?/giu;
    for (const match of sql.matchAll(declarations)) {
      const { name, operation, parameters, role } = Schema.decodeUnknownSync(
        Schema.Struct({
          name: Schema.String,
          operation: Schema.String,
          parameters: Schema.String,
          role: Schema.UndefinedOr(Schema.String),
        }),
      )(match.groups);
      const signature = `${name}(${parameters.toLowerCase().replaceAll(/\s+/gu, '')})`;
      if (operation.startsWith('DROP')) {
        signatures.delete(signature);
      } else if (role === 'ontos_runtime') {
        signatures.set(signature, name);
      }
    }
  }
  return EffectArray.sort([...signatures.values()], Order.String);
};

it('accepts the complete SQL-ordered runtime routine set through the verifier comparator', () => {
  expect(parsed.errors).toEqual([]);
  expect(source).toContain('array_agg(routine.proname::text order by routine.proname)');
  expect(source).toContain('!sameStrings(row.runtime_routines, EXPECTED_RUNTIME_ROUTINES)');
  expect(source).toContain('row.routine_count !== EXPECTED_RUNTIME_ROUTINES.length');
  expect(expected).toHaveLength(149);
  expect(new Set(expected).size).toBe(149);
  expect(shippedRuntimeRoutines()).toEqual(sqlOrdered);
  expect(expected).toContain('apply_customer_group_membership_source');
  expect(expected).toContain('lock_profile_ico_correlation');
  expect(expected).toContain('recover_market_retirement_reservation');
  expect(expected).toContain('read_customer_group_membership_source_receipt');
  expect(compare(sqlOrdered)).toBe(true);
});

it('rejects missing, duplicate, unexpected, and substituted runtime routines', () => {
  expect(compare(sqlOrdered.slice(1))).toBe(false);
  expect(compare(sqlOrdered.filter((routine) => routine !== 'lock_profile_ico_correlation'))).toBe(false);
  expect(compare(EffectArray.sort([sqlOrdered[1], ...sqlOrdered.slice(1)], Order.String))).toBe(false);
  expect(compare(EffectArray.sort([...sqlOrdered, 'unexpected_runtime_routine'], Order.String))).toBe(false);
  expect(compare(EffectArray.sort(['wrong_runtime_routine', ...sqlOrdered.slice(1)], Order.String))).toBe(false);
});
