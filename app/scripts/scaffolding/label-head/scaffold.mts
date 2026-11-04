import { Effect } from 'effect';

import { createCodesmithGenerator } from '../generator-adapter.mts';
import {
  LABEL_HEAD_GENERATOR_HEADER,
  createMutationEffect,
  discoverOntosModuleEffect,
  ensureUniqueMutationPaths,
  requireCanonicalSlug,
  resolveContainedPath,
  toCamelCase,
  toPascalCase,
  tryScaffold,
} from '../shared.mts';
import type { LabelHeadScaffoldConfig, LabelHeadScaffoldResult, ScaffoldPlan } from '../shared.mts';

const snakeCase = (slug: string): string => slug.replaceAll('-', '_');

/**
 * Owner-local label-head contract. The retained canonical reference, publication revision and
 * available/withdrawn state are owner-published facts; Core only consumes the reference and
 * revision. Publication never repurposes a source canonical revision.
 */
const renderLabelHeadContract = (moduleId: string, name: string): string => {
  const type = toPascalCase(name);
  return `${LABEL_HEAD_GENERATOR_HEADER}
// @ontos-label-head-owner ${moduleId}
// @ontos-label-head-name ${name}
import { Schema } from 'effect';

const resourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const tenantId = Schema.String.check(Schema.isUUID());
const legalEntityId = Schema.String.check(Schema.isUUID());
const publicationRevision = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u));
const boundedLabel = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

/**
 * Retained canonical owner reference. It is the exact module/resource identity plus the observing
 * tenant; it survives withdrawal and is never replaced by an ID-only key.
 */
export const ${type}LabelReferenceSchema = Schema.Struct({
  moduleId: Schema.Literal('${moduleId}'),
  resourceId,
  resourceType: Schema.Literal('${moduleId}.${name}'),
  tenantId,
});
export type ${type}LabelReference = typeof ${type}LabelReferenceSchema.Type;

/** Available publishes bounded label text; withdrawn retains the reference and revision only. */
export const ${type}LabelAvailabilitySchema = Schema.Literals(['available', 'withdrawn']);
export type ${type}LabelAvailability = typeof ${type}LabelAvailabilitySchema.Type;

/** Bounded published label text. Withdrawal removes this text without deleting the reference. */
export const ${type}LabelTextSchema = Schema.Struct({
  searchableText: Schema.Array(boundedLabel).check(Schema.isMaxLength(1000)),
  title: boundedLabel,
});
export type ${type}LabelText = typeof ${type}LabelTextSchema.Type;

/**
 * One owner-published label head. \`publicationRevision\` is this publication's own monotonic
 * revision, never the canonical source revision, and is compared as a decimal string.
 */
export const ${type}LabelHeadSchema = Schema.Struct({
  availability: ${type}LabelAvailabilitySchema,
  legalEntityId,
  publicationRevision,
  reference: ${type}LabelReferenceSchema,
  text: Schema.optionalKey(${type}LabelTextSchema),
}).check(
  Schema.makeFilter((head) =>
    head.availability === 'available'
      ? head.text === undefined
        ? 'An available label head requires bounded label text'
        : undefined
      : head.text === undefined
        ? undefined
        : 'A withdrawn label head must not retain label text',
  ),
);
export type ${type}LabelHead = typeof ${type}LabelHeadSchema.Type;
`;
};

/**
 * Owner-local schema starting point. It exposes a table factory so the owner supplies its own
 * schema name instead of the generator guessing one; RLS is forced through the shared owner policy
 * helper and no grant or cross-owner reference is added.
 */
const renderLabelHeadSchema = (name: string): string => {
  const type = toPascalCase(name);
  const camel = toCamelCase(name);
  const tableName = `${snakeCase(name)}_label_heads`;
  return `${LABEL_HEAD_GENERATOR_HEADER}
// @ontos-label-head-name ${name}
import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { bigint, check, jsonb, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { PgSchema } from 'drizzle-orm/pg-core';

export const ${camel}LabelHeadTableName = '${tableName}';

/**
 * Define the owner-local label-head table inside the owner's own PostgreSQL schema. The table
 * retains the canonical reference and publication revision, keeps \`available\`/\`withdrawn\` state,
 * and never stores an invalidation payload or a foreign owner reference.
 */
export const define${type}LabelHeads = (schema: PgSchema) =>
  schema.table.withRLS(
    ${camel}LabelHeadTableName,
    {
      tenantId: uuid('tenant_id').notNull(),
      legalEntityId: uuid('legal_entity_id').notNull(),
      sourceModuleKey: text('source_module_key').notNull(),
      sourceResourceType: text('source_resource_type').notNull(),
      sourceResourceId: text('source_resource_id').notNull(),
      publicationRevision: bigint('publication_revision', { mode: 'bigint' }).notNull(),
      availability: text('availability').notNull(),
      title: text('title').notNull().default(''),
      searchableTextJson: jsonb('searchable_text_json')
        .$type<readonly string[]>()
        .notNull()
        .default(sql\`'[]'::jsonb\`),
      createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
      primaryKey({
        columns: [
          table.tenantId,
          table.legalEntityId,
          table.sourceModuleKey,
          table.sourceResourceType,
          table.sourceResourceId,
        ],
      }),
      check('${snakeCase(name)}_label_heads_revision_ck', sql\`\${table.publicationRevision} >= 0\`),
      check('${snakeCase(name)}_label_heads_availability_ck', sql\`\${table.availability} in ('available', 'withdrawn')\`),
      ...tenantLegalEntityRlsPolicies('${tableName}', table.tenantId, table.legalEntityId),
    ],
  );
`;
};

/**
 * Source-only, least-privilege migration starting point. It creates only the owner-local table and
 * its tenant/legal-entity RLS policies. It never grants a role or broadens existing privileges;
 * reconcile it with the owner's drizzle-kit generated migration.
 */
const renderLabelHeadMigration = (name: string): string => {
  const tableName = `${snakeCase(name)}_label_heads`;
  return `${LABEL_HEAD_GENERATOR_HEADER}
// @ontos-label-head-name ${name}
import { Schema } from 'effect';

/** The owner schema name must be a canonical lowercase PostgreSQL identifier; decode, never throw. */
const ownerSchemaName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/u));

/**
 * Exact least-privilege statements for one owner schema. The owner passes its own schema name and
 * reconciles the result with its drizzle-kit migration; nothing here grants a role or widens access.
 */
export const ${toCamelCase(name)}LabelHeadMigrationStatements = (ownerSchema: string): readonly string[] => {
  const schema = Schema.decodeUnknownSync(ownerSchemaName)(ownerSchema);
  const table = '${tableName}';
  const scope =
    "tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid and legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid";
  return Object.freeze([
    \`create table if not exists "\${schema}"."\${table}" (
  tenant_id uuid not null,
  legal_entity_id uuid not null,
  source_module_key text not null,
  source_resource_type text not null,
  source_resource_id text not null,
  publication_revision bigint not null,
  availability text not null,
  title text not null default '',
  searchable_text_json jsonb not null default '[]'::jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint "\${table}_pk" primary key (tenant_id, legal_entity_id, source_module_key, source_resource_type, source_resource_id),
  constraint "\${table}_revision_ck" check (publication_revision >= 0),
  constraint "\${table}_availability_ck" check (availability in ('available', 'withdrawn'))
)\`,
    \`alter table "\${schema}"."\${table}" enable row level security\`,
    \`alter table "\${schema}"."\${table}" force row level security\`,
    \`create policy "\${table}_tenant_select" on "\${schema}"."\${table}" for select to ontos_runtime using (\${scope})\`,
    \`create policy "\${table}_tenant_insert" on "\${schema}"."\${table}" for insert to ontos_runtime with check (\${scope})\`,
    \`create policy "\${table}_tenant_update" on "\${schema}"."\${table}" for update to ontos_runtime using (\${scope}) with check (\${scope})\`,
  ]);
};
`;
};

/**
 * Owner-local service starting point. Publication is strictly monotonic per retained reference and
 * company; withdrawal retains the reference and revision while dropping label text. The store port
 * is injected so the owner binds it to its own transaction-scoped persistence.
 */
const renderLabelHeadService = (name: string): string => {
  const type = toPascalCase(name);
  const code = snakeCase(name);
  return `${LABEL_HEAD_GENERATOR_HEADER}
// @ontos-label-head-name ${name}
import { Effect, Option, Schema } from 'effect';

import { ${type}LabelHeadSchema } from '../../shared/labels/${name}.ts';
import type { ${type}LabelHead, ${type}LabelReference } from '../../shared/labels/${name}.ts';

export class ${type}LabelHeadInvalid extends Schema.TaggedError<${type}LabelHeadInvalid>()(
  '${type}LabelHeadInvalid',
  {
    code: Schema.Literal('${code}_label_head_invalid'),
    reason: Schema.String,
  },
) {}

export class ${type}LabelHeadUnavailable extends Schema.TaggedError<${type}LabelHeadUnavailable>()(
  '${type}LabelHeadUnavailable',
  {
    code: Schema.Literal('${code}_label_head_unavailable'),
    reason: Schema.String,
  },
) {}

/** Owner-local transaction-scoped persistence port. Never receives a raw database executor. */
export interface ${type}LabelHeadStore {
  readonly load: (
    reference: ${type}LabelReference,
    legalEntityId: string,
  ) => Effect.Effect<Option.Option<${type}LabelHead>, ${type}LabelHeadUnavailable>;
  readonly save: (head: ${type}LabelHead) => Effect.Effect<void, ${type}LabelHeadUnavailable>;
}

export interface ${type}LabelHeadService {
  readonly load: (
    reference: ${type}LabelReference,
    legalEntityId: string,
  ) => Effect.Effect<Option.Option<${type}LabelHead>, ${type}LabelHeadUnavailable>;
  readonly publish: (
    head: ${type}LabelHead,
  ) => Effect.Effect<void, ${type}LabelHeadInvalid | ${type}LabelHeadUnavailable>;
  readonly withdraw: (input: {
    readonly legalEntityId: string;
    readonly publicationRevision: string;
    readonly reference: ${type}LabelReference;
  }) => Effect.Effect<void, ${type}LabelHeadInvalid | ${type}LabelHeadUnavailable>;
}

const invalid = (reason: string): ${type}LabelHeadInvalid =>
  new ${type}LabelHeadInvalid({ code: '${code}_label_head_invalid', reason });

/** Monotonic publication: a newer revision supersedes an older one and a rollback is rejected. */
const validateMonotonic = (
  current: Option.Option<${type}LabelHead>,
  next: ${type}LabelHead,
): Effect.Effect<void, ${type}LabelHeadInvalid> =>
  Option.match(current, {
    onNone: () => Effect.void,
    onSome: (head) =>
      BigInt(next.publicationRevision) > BigInt(head.publicationRevision)
        ? Effect.void
        : Effect.fail(invalid('A label head publication revision must strictly increase')),
  });

export const make${type}LabelHeadService = (store: ${type}LabelHeadStore): ${type}LabelHeadService => ({
  load: (reference, legalEntityId) => store.load(reference, legalEntityId),
  publish: (head) =>
    Effect.gen(function* publishLabelHead() {
      const decoded = yield* Schema.decodeUnknownEffect(${type}LabelHeadSchema, {
        onExcessProperty: 'error',
      })(head).pipe(Effect.mapError(() => invalid('Label head payload is invalid')));
      const current = yield* store.load(decoded.reference, decoded.legalEntityId);
      yield* validateMonotonic(current, decoded);
      yield* store.save(decoded);
    }),
  withdraw: (input) =>
    Effect.gen(function* withdrawLabelHead() {
      // Validate the canonical withdrawn head before any store I/O, so a malformed revision or
      // reference fails through the typed channel instead of a BigInt defect mid-transaction.
      const decoded = yield* Schema.decodeUnknownEffect(${type}LabelHeadSchema, {
        onExcessProperty: 'error',
      })({
        availability: 'withdrawn',
        legalEntityId: input.legalEntityId,
        publicationRevision: input.publicationRevision,
        reference: input.reference,
      }).pipe(Effect.mapError(() => invalid('Withdrawn label head payload is invalid')));
      const current = yield* store.load(decoded.reference, decoded.legalEntityId);
      if (Option.isNone(current)) {
        return yield* invalid('A withdrawn label head must retain its exact canonical reference');
      }
      yield* validateMonotonic(current, decoded);
      yield* store.save(decoded);
    }),
});
`;
};

const renderLabelHeadVerifier = (name: string): string => {
  const tableName = `${snakeCase(name)}_label_heads`;
  return `/// <reference types="node" />
${LABEL_HEAD_GENERATOR_HEADER}
// @ontos-label-head-name ${name}
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { NodeRuntime } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Console, Effect, Redacted, Schema } from 'effect';

class OwnerVerificationError extends Schema.TaggedError<OwnerVerificationError>()('OwnerVerificationError', {
  reason: Schema.String,
}) {}

const ownerSchema = process.argv[2] ?? '';

interface LabelHeadInfrastructure {
  readonly availability_check: boolean;
  readonly enabled: boolean;
  readonly forced: boolean;
  readonly no_external_fk: boolean;
  readonly policies: number;
  readonly primary_key: boolean;
  readonly revision_check: boolean;
  readonly runtime_bypass: boolean;
}

const main = Effect.scoped(
  Effect.gen(function* verifyLabelHeadDatabase() {
    if (!/^[a-z][a-z0-9_]*$/u.test(ownerSchema)) {
      return yield* Effect.fail(
        new OwnerVerificationError({ reason: 'Pass the owner PostgreSQL schema name as the first argument' }),
      );
    }
    const pair = yield* loadDatabaseConnectionPair();
    const client = yield* PgClient.makeClient({ url: Redacted.make(pair.runtime.connectionString) });
    const rows = yield* client.unsafe<LabelHeadInfrastructure>(
      \`select
      c.relrowsecurity as enabled,
      c.relforcerowsecurity as forced,
      (select count(*)::int from pg_catalog.pg_policy where polrelid = c.oid) as policies,
      exists(select 1 from pg_catalog.pg_constraint where conrelid = c.oid and contype = 'p') as primary_key,
      exists(select 1 from pg_catalog.pg_constraint where conrelid = c.oid and contype = 'c' and pg_get_constraintdef(oid) like '%publication_revision%') as revision_check,
      exists(select 1 from pg_catalog.pg_constraint where conrelid = c.oid and contype = 'c' and pg_get_constraintdef(oid) like '%availability%') as availability_check,
      not exists(
        select 1 from pg_catalog.pg_constraint f
        join pg_catalog.pg_class target on target.oid = f.confrelid
        join pg_catalog.pg_namespace n on n.oid = target.relnamespace
        where f.conrelid = c.oid and f.contype = 'f' and n.nspname <> $1
      ) as no_external_fk,
      (select rolbypassrls from pg_catalog.pg_roles where rolname = current_user) as runtime_bypass
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = $1 and c.relname = '${tableName}'\`,
      [ownerSchema],
    );
    const [row] = rows;
    if (
      row === undefined ||
      !row.enabled ||
      !row.forced ||
      row.policies !== 3 ||
      !row.primary_key ||
      !row.revision_check ||
      !row.availability_check ||
      !row.no_external_fk ||
      row.runtime_bypass
    ) {
      return yield* Effect.fail(
        new OwnerVerificationError({
          reason: 'Owner label-head table is missing forced RLS or its exact constraints',
        }),
      );
    }
    yield* Console.log(\`Verified \${ownerSchema}.${tableName}\`);
  }),
);

NodeRuntime.runMain(main);
`;
};

const planLabelHeadScaffold = Effect.fn('LabelHeadScaffold.plan')(function* planLabelHeadScaffold(
  workspaceRoot: string,
  config: LabelHeadScaffoldConfig,
) {
  const name = yield* tryScaffold('label head name is invalid', () => requireCanonicalSlug(config.name, 'label head'));
  const vertical = yield* discoverOntosModuleEffect(workspaceRoot, config.vertical);
  const contractPath = yield* tryScaffold('failed to resolve label-head contract path', () =>
    resolveContainedPath(vertical.directory, 'shared', 'labels', `${name}.ts`),
  );
  const schemaPath = yield* tryScaffold('failed to resolve label-head schema path', () =>
    resolveContainedPath(vertical.directory, 'src', 'database', `${name}-label-head.ts`),
  );
  const migrationPath = yield* tryScaffold('failed to resolve label-head migration path', () =>
    resolveContainedPath(vertical.directory, 'src', 'database', `${name}-label-head.migration.ts`),
  );
  const servicePath = yield* tryScaffold('failed to resolve label-head service path', () =>
    resolveContainedPath(vertical.directory, 'src', 'services', `${name}-label-head.service.ts`),
  );
  const verifierPath = yield* tryScaffold('failed to resolve label-head verifier path', () =>
    resolveContainedPath(vertical.directory, 'scripts', `verify-${name}-label-head.mts`),
  );
  const mutations = [
    yield* createMutationEffect(contractPath, renderLabelHeadContract(vertical.moduleId, name)),
    yield* createMutationEffect(schemaPath, renderLabelHeadSchema(name)),
    yield* createMutationEffect(migrationPath, renderLabelHeadMigration(name)),
    yield* createMutationEffect(servicePath, renderLabelHeadService(name)),
    yield* createMutationEffect(verifierPath, renderLabelHeadVerifier(name)),
  ];
  yield* tryScaffold('label-head mutation paths are invalid', () => ensureUniqueMutationPaths(mutations));
  return {
    mutations,
    result: { contractPath, migrationPath, schemaPath, servicePath, verifierPath },
  } satisfies ScaffoldPlan<LabelHeadScaffoldResult>;
});

export default createCodesmithGenerator(planLabelHeadScaffold);
