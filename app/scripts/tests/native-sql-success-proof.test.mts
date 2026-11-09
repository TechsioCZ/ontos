import { Effect, Path, Schema } from 'effect';
import { parseSync, Visitor } from 'oxc-parser';
import type { Expression, Span } from 'oxc-parser';
import { makeScopedContextFactoryResolver } from '../scoped-context-factory-proof.mts';
import {
  describeNativeSqlDatabase,
  describeNativeSqlTransaction,
  describeNativeSqlExecute,
  describeNativeSqlTextSelection,
  parseClosedNativeSelectProjection,
} from '../native-sql-success-proof.mts';
import type {
  NativeSqlDatabaseDescriptor,
  NativeSqlProofEnvironment,
  NativeSqlSourceReference,
} from '../native-sql-success-proof.mts';
import { expect, it } from 'effect-rstest';

it('derives own wire aliases from the actual closed scope verification SELECT', () => {
  expect(
    parseClosedNativeSelectProjection(
      "select current_user::text as role, current_setting('ontos.tenant_id', true) as tenant_id, current_setting('ontos.legal_entity_id', true) as legal_entity_id",
    ),
  ).toEqual(['role', 'tenant_id', 'legal_entity_id']);
});

it.each([
  'select current_user::text',
  'select current_user::text as role; select malicious() as tenant_id',
  'select current_user::text as role, another() as role',
  'select * from source',
])('keeps unproved or ambiguous SELECT syntax unknown: %s', (source) => {
  expect(parseClosedNativeSelectProjection(source)).toBeUndefined();
});

const nativeFixture = (
  changes: {
    readonly bodyPrefix?: string;
    readonly config?: string;
    readonly factory?: string;
    readonly prefix?: string;
    readonly receiver?: string;
    readonly statement?: string;
    readonly suffix?: string;
  } = {},
) => `
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { sql } from 'drizzle-orm';
import { Effect } from 'effect';
${changes.prefix ?? ''}
const client = PgClient.make(${changes.config ?? '{url: connectionString, maxConnections: 4}'});
const db = ${changes.factory ?? 'makeWithDefaults'}({relations}).pipe(Effect.provideService(PgClient.PgClient, client));
db.transaction((transaction) => {${changes.bodyPrefix ?? ''} return ${changes.receiver ?? 'transaction'}.execute(${changes.statement ?? "sql`select current_user::text as role, current_setting('ontos.tenant_id', true) as tenant_id`"}, 'objects');});
${changes.suffix ?? ''}
export const probe = () => 0; probe();
`;
const exercisePublicCaptures = (
  database: NativeSqlDatabaseDescriptor,
  captureBinding: Span | undefined,
  replacement: NativeSqlSourceReference,
) => {
  const entry = database.executor.captures?.values().next().value;
  expect(entry).toBeDefined();
  if (entry !== undefined) {
    expect(() => Object.assign(entry, { file: '/forged.ts' })).toThrow();
  }
  if (captureBinding !== undefined && Schema.is(Schema.instanceOf(Map))(database.executor.captures)) {
    database.executor.captures.set(captureBinding, replacement);
  }
};
const fixtureProof = (
  source: string,
  forged?: 'captureReplacement' | 'database' | 'freshFrames' | 'parameter' | 'transaction',
) =>
  Effect.gen(function* fixture(): Effect.fn.Return<readonly string[] | undefined, never, Path.Path> {
    const file = '/fixture/main.ts';
    const path = yield* Path.Path;
    const resolver = makeScopedContextFactoryResolver(new Map([[file, source]]), '/fixture', path, new Map());
    const parsed = parseSync(file, source, { sourceType: 'module' });
    expect(parsed.errors).toEqual([]);
    let probe: Expression | undefined;
    new Visitor({
      CallExpression: (node) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'probe') {
          probe = node.callee;
        }
      },
    }).visit(parsed.program);
    if (probe === undefined) {
      return undefined;
    }
    resolver.resolveDeclaredFunction({ callee: probe, file });
    const modules = resolver.runtimeProofModules();
    const module = modules.find((candidate) => candidate.file === file);
    if (module === undefined) {
      return undefined;
    }
    const resolveValue = (input: NativeSqlSourceReference): NativeSqlSourceReference | undefined => {
      let current = input;
      const seen = new Set<Expression>();
      for (let depth = 0; depth < 32 && !seen.has(current.expression); depth += 1) {
        seen.add(current.expression);
        const { expression } = current;
        if (expression.type !== 'Identifier') {
          return current;
        }
        const binding = module.bindings.find(
          (candidate) =>
            candidate.name === expression.name &&
            candidate.scope.start <= expression.start &&
            expression.end <= candidate.scope.end,
        );
        if (binding?.init !== undefined && binding.kind === 'const') {
          current = { expression: binding.init, file: input.file };
        } else if (
          binding?.parameter !== undefined &&
          binding.node === binding.parameter.fn.params[binding.parameter.index]
        ) {
          return current;
        } else {
          return current;
        }
      }
      return undefined;
    };
    const captureBinding = module.bindings.find((binding) => binding.name === 'probe');
    const captureSource = module.bindings.find((binding) => binding.name === 'client')?.init;
    const witnessCaptures = new Map<Span, NativeSqlSourceReference>();
    if (captureBinding !== undefined && captureSource !== undefined) {
      witnessCaptures.set(captureBinding.node, { expression: captureSource, file });
    }
    const environment: NativeSqlProofEnvironment = {
      modules,
      resolveFunction: (ref) => resolver.resolveNativeSqlFunction(ref),
      resolveImport: (_file, specifier) => {
        if (specifier === '@effect/sql-pg') {
          return { kind: 'native-pg-root' };
        }
        if (specifier === 'drizzle-orm/effect-postgres') {
          return { kind: 'native-drizzle-effect' };
        }
        if (specifier === 'drizzle-orm') {
          return { kind: 'native-drizzle' };
        }
        return specifier === 'effect' ? { kind: 'native-effect' } : undefined;
      },
      resolveValue: (reference) => {
        const value = resolveValue(reference);
        if (value !== undefined && forged === 'captureReplacement') {
          return { ...value, captures: witnessCaptures };
        }
        if (value !== undefined && forged === 'freshFrames') {
          return { ...value, captures: new Map(value.captures) };
        }
        return value;
      },
    };
    const db = module.bindings.find((binding) => binding.name === 'db')?.init;
    let transaction: Expression | undefined;
    let execute: Expression | undefined;
    new Visitor({
      CallExpression: (node) => {
        if (
          node.callee.type === 'MemberExpression' &&
          !node.callee.computed &&
          node.callee.property.type === 'Identifier'
        ) {
          if (node.callee.property.name === 'transaction') {
            transaction = node;
          }
          if (node.callee.property.name === 'execute') {
            execute = node;
          }
        }
      },
    }).visit(module.program);
    if (db === undefined || transaction === undefined || execute === undefined) {
      return undefined;
    }
    const database = describeNativeSqlDatabase(environment, { expression: db, file });
    if (database === undefined) {
      return undefined;
    }
    if (forged === 'captureReplacement') {
      exercisePublicCaptures(database, captureBinding?.node, { expression: db, file });
    }
    const descriptor = describeNativeSqlTransaction(environment, forged === 'database' ? { ...database } : database, {
      expression: transaction,
      file,
    });
    if (forged === 'parameter' && descriptor !== undefined) {
      expect(() => Object.assign(descriptor.parameter, { file: '/forged.ts' })).toThrow();
    }
    return descriptor === undefined
      ? undefined
      : describeNativeSqlExecute(environment, forged === 'transaction' ? { ...descriptor } : descriptor, {
          expression: execute,
          file,
        });
  }).pipe(Effect.provide(Path.layer));

it.effect('derives wire fields through genuine native constructor, provider and transaction parameter', () =>
  fixtureProof(nativeFixture()).pipe(Effect.map((fields) => expect(fields).toEqual(['role', 'tenant_id']))),
);
for (const [name, changes] of [
  ['fake receiver', { receiver: 'fake' }],
  ['custom decoder types', { config: '{url: connectionString, types: customTypes}' }],
  ['custom row hook', { config: '{url: connectionString, transformRows: hook}' }],
  ['default wrapper', { factory: 'wrappedDefaults' }],
  ['shadowed native tag', { statement: '((sql) => sql`select current_user as role`)(fake)' }],
  ['interpolation', { statement: ['sql`select ', '{value} as role`'].join('$') }],
  ['raw fragment', { statement: 'sql.raw("select current_user as role")' }],
  ['unaliased field', { statement: 'sql`select current_user`' }],
  ['native Effect provider mutation', { suffix: 'Effect.provideService=foreign;' }],
  [
    'native Effect provider alias mutation',
    { prefix: 'const effectAlias=Effect;', suffix: 'effectAlias.provideService=foreign;' },
  ],
  ['native Effect mapError mutation', { suffix: 'Effect.mapError=foreign;' }],
  ['client instance mutation', { suffix: 'client.execute=foreign;' }],
  ['client instance escape', { suffix: 'foreign(client);' }],
  ['class static database storage mutation', { suffix: 'class Hold {static db=db;} Hold.db.transaction=foreign;' }],
  ['database instance mutation', { suffix: 'db.transaction=foreign;' }],
  ['database instance escape', { suffix: 'foreign(db);' }],
  ['database container escape', { suffix: 'foreign({executor:db});' }],
  ['transaction instance escape', { receiver: '(foreign(transaction),transaction)' }],
  ['transaction instance mutation', { receiver: '(transaction.execute=foreign,transaction)' }],
  ['shadowed native tag binding', { bodyPrefix: 'const sql=fake;' }],
  ['transaction handle foreign escape', { bodyPrefix: 'foreign(transaction);' }],
  ['transaction handle method replacement', { bodyPrefix: 'transaction.execute=foreign;' }],
  [
    'known forwarding mutation',
    { prefix: 'const replace=(handle)=>{handle.transaction=foreign;};', suffix: 'replace(db);' },
  ],
  ['native tag mutation', { suffix: 'sql.custom = foreign;' }],
  ['native maker mutation', { suffix: 'PgClient.make = foreign;' }],
  ['native tag alias escape', { prefix: 'const tag=sql; foreign(tag);' }],
  ['native namespace escape', { suffix: 'foreign(PgClient);' }],
  ['native maker alias escape', { prefix: 'const maker=PgClient.make; foreign(maker);' }],
  ['config alias mutation', { config: 'cfg', prefix: 'const cfg={url:connectionString}; cfg.types=customTypes;' }],
  ['config alias escape', { config: 'cfg', prefix: 'const cfg={url:connectionString}; foreign(cfg);' }],
  [
    'config alias container escape',
    { config: 'cfg', prefix: 'const cfg={url:connectionString}; const box={cfg}; foreign(box);' },
  ],
  ['unknown config spread', { config: '{...foreignConfig, url: connectionString}' }],
] as const) {
  it.effect(`keeps ${name} unknown`, () =>
    fixtureProof(nativeFixture(changes)).pipe(Effect.map((fields) => expect(fields).toBeUndefined())),
  );
}

for (const forged of ['database', 'transaction'] as const) {
  it.effect(`rejects a fabricated ${forged} descriptor`, () =>
    fixtureProof(nativeFixture(), forged).pipe(Effect.map((fields) => expect(fields).toBeUndefined())),
  );
}
it.effect('accepts a stable native tag alias', () =>
  fixtureProof(nativeFixture({ prefix: 'const tag=sql;', statement: 'tag`select current_user as role`' })).pipe(
    Effect.map((fields) => expect(fields).toEqual(['role'])),
  ),
);

it.each([
  "select 'as fake'",
  'select current_user as role -- as tenant_id',
  'select current_user as role /* as tenant_id */',
  'select current_user as "role"',
  "select current_user as 'role'",
  'select current_user as role, 1 as ROLE',
  'select current_user as __proto__',
  'select current_user as constructor',
  'select (select current_user as nested) as role',
  'select current_user as role from users',
  'select current_user as role union select current_user as role',
  'select current_user as role;',
  'select current_user as role,',
  'select current_user as role !!!',
  'select current_user as role where true',
])('fully consumes closed SQL and rejects unsupported syntax: %s', (source) => {
  expect(parseClosedNativeSelectProjection(source)).toBeUndefined();
});

it('preserves PostgreSQL wire aliases up to the native 63 ASCII byte boundary', () => {
  const alias = 'a'.repeat(63);
  expect(parseClosedNativeSelectProjection(`select 1 as ${alias}`)).toEqual([alias]);
});
it('rejects overlong aliases and collisions after native identifier truncation', () => {
  const prefix = 'a'.repeat(63);
  expect(parseClosedNativeSelectProjection(`select 1 as ${prefix}x`)).toBeUndefined();
  expect(parseClosedNativeSelectProjection(`select 1 as ${prefix}x, 2 as ${prefix}y`)).toBeUndefined();
});

it.effect('protects genuine descriptor facts from nested record replacement', () =>
  fixtureProof(nativeFixture(), 'parameter').pipe(
    Effect.map((fields) => expect(fields).toEqual(['role', 'tenant_id'])),
  ),
);
it.effect('preserves unrelated native Effect calls in the participating source', () =>
  fixtureProof(nativeFixture({ suffix: 'Effect.succeed(1);Effect.asVoid;' })).pipe(
    Effect.map((fields) => expect(fields).toEqual(['role', 'tenant_id'])),
  ),
);
it.effect('preserves unrelated native Drizzle builders in the participating source', () =>
  fixtureProof(nativeFixture({ prefix: "import { eq } from 'drizzle-orm';", suffix: 'eq(left,right);' })).pipe(
    Effect.map((fields) => expect(fields).toEqual(['role', 'tenant_id'])),
  ),
);

const nativeTextColumn = "text('outcome_code').notNull()";
const selectedProof = (column = nativeTextColumn, receiver = 'db', suffix = '') =>
  Effect.gen(function* selectedFixture(): Effect.fn.Return<readonly string[] | undefined, never, Path.Path> {
    const path = yield* Path.Path;
    const file = '/fixture/packages/owner/src/repo.ts';
    const schemaFile = '/fixture/packages/owner/src/schema.ts';
    const schema = `import {pgSchema,text,customType} from 'drizzle-orm/pg-core';const coreSchema=pgSchema('core');export const auditEvents=coreSchema.table('audit_events',{outcomeCode:${column},outcomeStage:text('outcome_stage').notNull()});`;
    const source = nativeFixture({
      prefix: "import {auditEvents} from './schema.ts';",
      suffix: `${receiver}.select({outcomeCode:auditEvents.outcomeCode,outcomeStage:auditEvents.outcomeStage}).from(auditEvents).where(predicate).limit(1);${suffix}`,
    });
    const sources = new Map([
      [file, source],
      [schemaFile, schema],
      ['/fixture/packages/owner/package.json', '{"name":"@app/owner","type":"module"}'],
    ]);
    const resolver = makeScopedContextFactoryResolver(sources, '/fixture', path, new Map());
    const parsed = parseSync(file, source, { sourceType: 'module' });
    let probe: Expression | undefined;
    new Visitor({
      CallExpression: (node) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'probe') {
          probe = node.callee;
        }
      },
    }).visit(parsed.program);
    if (probe === undefined) {
      return undefined;
    }
    resolver.resolveDeclaredFunction({ callee: probe, file });
    const modules = resolver.runtimeProofModules();
    const module = modules.find((candidate) => candidate.file === file);
    if (module === undefined) {
      return undefined;
    }
    const environment: NativeSqlProofEnvironment = {
      modules,
      resolveFunction: (ref) => resolver.resolveNativeSqlFunction(ref),
      resolveImport: (from, specifier) => {
        if (specifier === '@effect/sql-pg') {
          return { kind: 'native-pg-root' };
        }
        if (specifier === 'drizzle-orm/effect-postgres') {
          return { kind: 'native-drizzle-effect' };
        }
        if (specifier === 'drizzle-orm') {
          return { kind: 'native-drizzle' };
        }
        if (specifier === 'effect') {
          return { kind: 'native-effect' };
        }
        return from === file && specifier === './schema.ts' ? { file: schemaFile, kind: 'module' } : undefined;
      },
      resolveValue: (ref) => resolver.resolveNativeSqlSource(ref),
    };
    const db = module.bindings.find((binding) => binding.name === 'db')?.init;
    let query: Expression | undefined;
    new Visitor({
      CallExpression: (node) => {
        if (
          node.callee.type === 'MemberExpression' &&
          !node.callee.computed &&
          node.callee.property.type === 'Identifier' &&
          node.callee.property.name === 'limit'
        ) {
          query = node;
        }
      },
    }).visit(module.program);
    if (db === undefined || query === undefined) {
      return undefined;
    }
    const descriptor = describeNativeSqlDatabase(environment, { expression: db, file });
    if (descriptor === undefined) {
      return undefined;
    }
    return describeNativeSqlTextSelection(
      environment,
      descriptor,
      { expression: query, file },
      {
        filename: 'packages/owner/src/schema.ts',
        ownerPath: 'packages/owner',
        runtimeFile: schemaFile,
        sources: new Map([...sources].map(([name, value]) => [name.slice('/fixture/'.length), value])),
        tableExportName: 'auditEvents',
      },
    );
  }).pipe(Effect.provide(Path.layer));

it.effect('derives selected own keys through genuine native PgText builders and native executor', () =>
  selectedProof().pipe(Effect.map((fields) => expect(fields).toEqual(['outcomeCode', 'outcomeStage']))),
);
it.effect('allows an unrelated own-data field with the same selected column name', () =>
  selectedProof(nativeTextColumn, 'db', "const payload={outcomeCode:'unrelated'}; foreign(payload.outcomeCode);").pipe(
    Effect.map((fields) => expect(fields).toEqual(['outcomeCode', 'outcomeStage'])),
  ),
);
for (const [name, column, receiver, suffix] of [
  ['injected selector', nativeTextColumn, 'fake', ''],
  ['custom mapper', "text('outcome_code').mapWith(custom)", 'db', ''],
  ['array decoder', "text('outcome_code').array()", 'db', ''],
  ['custom column', "customType({dataType:()=> 'text'})('outcome_code')", 'db', ''],
  ['column decoder replacement', nativeTextColumn, 'db', 'auditEvents.outcomeCode.mapFromDriverValue=foreign;'],
  [
    'class static column storage mutation',
    nativeTextColumn,
    'db',
    'class Hold {static column=auditEvents.outcomeCode;} Hold.column.mapFromDriverValue=foreign;',
  ],
  ['column handle escape', nativeTextColumn, 'db', 'foreign(auditEvents.outcomeCode);'],
  ['aliased column handle escape', nativeTextColumn, 'db', 'const column=auditEvents.outcomeCode; foreign(column);'],
] as const) {
  it.effect(`keeps selected ${name} unknown`, () =>
    selectedProof(column, receiver, suffix).pipe(Effect.map((fields) => expect(fields).toBeUndefined())),
  );
}

it.effect('preserves actual equal captures across fresh resolver map wrappers', () =>
  fixtureProof(nativeFixture(), 'freshFrames').pipe(
    Effect.map((fields) => expect(fields).toEqual(['role', 'tenant_id'])),
  ),
);
it.effect('follows a source-proved first-party native handle forwarder', () =>
  fixtureProof(nativeFixture({ prefix: 'const use=(handle)=>handle.select({});', suffix: 'use(db);' })).pipe(
    Effect.map((fields) => expect(fields).toEqual(['role', 'tenant_id'])),
  ),
);

it.effect('keeps trusted capture facts private when public map storage is replaced', () =>
  fixtureProof(nativeFixture(), 'captureReplacement').pipe(
    Effect.map((fields) => expect(fields).toEqual(['role', 'tenant_id'])),
  ),
);
