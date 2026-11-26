import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

import { Array as EffectArray, Option, Order, Schema } from 'effect';
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
  [declaration('EXPECTED_RUNTIME_ROUTINES'), declaration('EXPECTED_TRIGGER_NAMES'), declaration('sameStrings')].join(
    '\n',
  ),
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
          role: Schema.OptionFromUndefinedOr(Schema.String),
        }),
      )(match.groups);
      const signature = `${name}(${parameters.toLowerCase().replaceAll(/\s+/gu, '')})`;
      if (operation.toUpperCase().startsWith('DROP')) {
        signatures.delete(signature);
      } else if (Option.getOrUndefined(role) === 'ontos_runtime') {
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
  expect(new Set(expected).size).toBe(expected.length);
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

const expectedTriggers = Schema.decodeUnknownSync(Schema.Array(Schema.String))(
  JSON.parse(executeDeclarations('EXPECTED_TRIGGER_NAMES')),
);
const compareTriggers = (actual: readonly string[]): boolean =>
  Schema.decodeUnknownSync(Schema.Boolean)(
    JSON.parse(executeDeclarations(`sameStrings(${JSON.stringify(actual)}, EXPECTED_TRIGGER_NAMES)`)),
  );

it('requires the exact 47 native Commerce triggers in both installation inventories', () => {
  expect(expectedTriggers).toHaveLength(47);
  expect(new Set(expectedTriggers).size).toBe(expectedTriggers.length);
  expect(expectedTriggers).toEqual(EffectArray.sort(expectedTriggers, Order.String));
  expect(expectedTriggers).not.toContain('symmy_demo_group_membership_route');
  expect(compareTriggers(expectedTriggers)).toBe(true);
  // Both native inventory queries remove only the catalog OID of a completely validated foreign hook.
  expect(source.match(/trigger_record\.oid not in \(select oid from validated_foreign_triggers\)/gu)).toHaveLength(2);
  expect(source).toContain('with validated_foreign_triggers as (');
  expect(source).toContain('select trigger_record.oid');
  expect(source).toContain('row.trigger_count !== EXPECTED_TRIGGER_NAMES.length');
  expect(source).toContain('!sameStrings(row.trigger_names, EXPECTED_TRIGGER_NAMES)');
  expect(source).not.toContain('!row.demo_membership_trigger_safe');
  expect(source).not.toContain("trigger_record.tgname <> 'symmy_demo_group_membership_route'");
});

it('rejects missing, duplicate, unexpected and substituted native triggers', () => {
  for (const trigger of expectedTriggers) {
    expect(compareTriggers(expectedTriggers.filter((name) => name !== trigger))).toBe(false);
    expect(compareTriggers(EffectArray.sort([...expectedTriggers, trigger], Order.String))).toBe(false);
  }
  for (const extra of ['another_demo_trigger', 'symmy_demo_group_membership_route']) {
    // An extra hook with the right name but the wrong table/function is not a validated foreign OID.
    expect(compareTriggers(EffectArray.sort([...expectedTriggers, extra], Order.String))).toBe(false);
    expect(compareTriggers(EffectArray.sort([extra, ...expectedTriggers.slice(1)], Order.String))).toBe(false);
  }
});

const symmySource = readFileSync(
  new URL('../../../symmy-integration/scripts/verify-db-schema.mts', import.meta.url),
  'utf-8',
);
const symmyParsed = parseSync('symmy-verify-db-schema.mts', symmySource);
const symmyHookDeclaration = symmyParsed.program.body.find(
  (entry) =>
    entry.type === 'VariableDeclaration' &&
    entry.declarations.some((item) => item.id.type === 'Identifier' && item.id.name === 'verifyDemoMembershipTrigger'),
);
const symmyErrorDeclaration = symmyParsed.program.body.find(
  (entry) => entry.type === 'ClassDeclaration' && entry.id?.name === 'SymmySchemaVerificationError',
);

it('recognizes only the exact safe foreign hook in Commerce and requires it in Symmy', () => {
  expect(symmyParsed.errors).toEqual([]);
  for (const predicate of [
    "relation.relname = 'customer_group_definition_source_bindings'",
    "trigger_record.tgname = 'symmy_demo_group_membership_route'",
    'not trigger_record.tgisinternal',
    'trigger_record.tgtype = 21',
    'trigger_record.tgconstraint = 0',
    "trigger_record.tgenabled = 'O'",
    'trigger_record.tgnargs = 0',
    'trigger_record.tgqual is null',
    "trigger_record.tgattr = ''::pg_catalog.int2vector",
    "routine_namespace.nspname = 'symmy_integration'",
    "routine.proname = 'materialize_demo_group_membership_route'",
    'routine.prosecdef',
    "not has_function_privilege('ontos_runtime', routine.oid, 'EXECUTE')",
    'routine.oid = trigger_record.tgfoid',
    'relation.oid = trigger_record.tgrelid',
  ]) {
    expect(source).toContain(predicate);
    expect(symmySource).toContain(predicate);
  }
  expect(symmySource).toContain("namespace.nspname = 'commerce_customer_context'");
  expect(symmySource).toContain('yield* verifyDemoMembershipTrigger(client)');
  expect(symmySource).toContain('!hook?.demo_membership_trigger_safe');
});

it('accepts the installed safe hook and rejects missing, misbound or disabled hook catalog results', () => {
  if (symmyHookDeclaration === undefined || symmyErrorDeclaration === undefined) {
    throw new Error('Missing mandatory Symmy hook verification');
  }
  const declarations = stripTypeScriptTypes(
    [
      symmySource.slice(symmyErrorDeclaration.start, symmyErrorDeclaration.end),
      symmySource.slice(symmyHookDeclaration.start, symmyHookDeclaration.end),
    ].join('\n'),
  );
  // PostgreSQL EXISTS rejects absent hooks and definitions that do not match the installed ordinary trigger.
  const results = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import { Effect, Schema } from 'effect';
    ${declarations}
    const cases = [
      [{ demo_membership_trigger_safe: true }],
      [{ demo_membership_trigger_safe: false }],
      [],
    ];
    const results = await Promise.all(cases.map(rows => Effect.runPromise(
      verifyDemoMembershipTrigger(() => Effect.succeed(rows)).pipe(
        Effect.match({ onFailure: () => false, onSuccess: () => true }),
      ),
    )));
    process.stdout.write(JSON.stringify(results));
  `,
    ],
    { encoding: 'utf-8' },
  );
  expect(JSON.parse(results)).toEqual([true, false, false]);
});

it('bounds and redacts both payment-term child diagnostic streams before logging failures', () => {
  for (const name of ['payment-term-legacy-intent-postgres', 'payment-term-finite-cancellation-postgres']) {
    const fixtureSource = readFileSync(new URL(`../integration/${name}.test.ts`, import.meta.url), 'utf-8');
    const collectionStart = fixtureSource.indexOf('  const collectOutput =');
    const collectionEnd = fixtureSource.indexOf('  const [status, stderr, stdout]', collectionStart);
    const redactionStart = fixtureSource.indexOf('    const redactOutput =');
    const redactionEnd = fixtureSource.indexOf('    const text = redactOutput(stderr)', redactionStart);
    expect(collectionStart).toBeGreaterThan(0);
    expect(collectionEnd).toBeGreaterThan(collectionStart);
    expect(redactionStart).toBeGreaterThan(0);
    expect(redactionEnd).toBeGreaterThan(redactionStart);
    const declarations = stripTypeScriptTypes(
      [fixtureSource.slice(collectionStart, collectionEnd), fixtureSource.slice(redactionStart, redactionEnd)].join(
        '\n',
      ),
    );
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import { Effect, Stream } from 'effect';
      const connections = {
        admin: { connectionString: 'postgres://admin:admin-secret@db.invalid/test' },
        runtime: { connectionString: 'postgresql://runtime:runtime-secret@db.invalid/test' },
      };
      ${declarations}
      const url = connections.admin.connectionString;
      const collected = await Effect.runPromise(Stream.make(
        'Verifier rejected inventory: ' + url.slice(0, 15),
        url.slice(15) + ' ' + connections.runtime.connectionString + ' ',
        'postgresql://another:another-secret@db.invalid/test ' + 'x'.repeat(20_000),
      ).pipe(collectOutput));
      const output = redactOutput(collected);
      process.stdout.write(JSON.stringify({
        boundedCollection: collected.length === 16_384,
        boundedOutput: output.length <= 8192,
        retainsDiagnosis: output.startsWith('Verifier rejected inventory: [REDACTED_DATABASE_URL]'),
        redacted: !/postgres|secret|db[.]invalid/u.test(output),
      }));
    `,
      ],
      { encoding: 'utf-8' },
    );
    expect(JSON.parse(result)).toEqual({
      boundedCollection: true,
      boundedOutput: true,
      redacted: true,
      retainsDiagnosis: true,
    });
    expect(fixtureSource).toContain('stderr: text');
    expect(fixtureSource).toContain('stdout: redactOutput(stdout)');
  }
});
