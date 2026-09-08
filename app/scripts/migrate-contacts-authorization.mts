#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import {
  Console,
  Effect,
  Exit,
  ManagedRuntime,
  Number as EffectNumber,
  Redacted,
  Result,
  Schema,
} from 'effect';
import { Argument, Command } from 'effect/unstable/cli';
import { Pool } from 'pg';
import { loadDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import {
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../packages/core-runtime/src/permissions/context-access.ts';
import {
  fullyConsistent,
  spiceDbClientSecurity,
} from '../packages/core-runtime/src/permissions/client.ts';
import type { SpiceDbConfigValue } from '../packages/core-runtime/src/permissions/config.ts';
import { loadSpiceDbConfig } from '../packages/core-runtime/src/permissions/config.ts';

const LEGACY_MODULE_ID = 'crm.core';
const CONTACTS_MODULE_ID = 'contacts.core';
const MAX_CONTEXTS = 500;
const MAX_PRINCIPALS = 5000;
const MAX_RELATIONSHIPS_PER_CONTEXT = 100;
const DENIED_PROBE_PRINCIPAL_ID = 'contacts-identity-migration-denied-probe';
const OUTSIDE_AUTHORITATIVE_CONTEXT_MESSAGE =
  'A module-access relationship is outside the authoritative context';

const ContactsAuthorizationMigrationModeSchema = Schema.Literals(['finalize', 'prepare', 'verify']);

export type ContactsAuthorizationMigrationMode =
  typeof ContactsAuthorizationMigrationModeSchema.Type;

export class ContactsAuthorizationMigrationError extends Schema.TaggedError<ContactsAuthorizationMigrationError>()(
  'ContactsAuthorizationMigrationError',
  { message: Schema.String },
) {}

export interface ContactsAuthorizationRelationship {
  readonly relation: 'accessor' | 'legal_entity';
  readonly subjectId: string;
  readonly subjectType: 'legal_entity' | 'principal';
}

export interface ContactsAuthorizationContextPlan {
  readonly deleteLegacy: boolean;
  readonly state: 'already_finalized' | 'already_prepared' | 'legacy_only' | 'unconfigured';
  readonly touchContacts: boolean;
}

interface DatabaseContextRow {
  readonly legal_entity_id: string;
  readonly module_key: string;
  readonly tenant_id: string;
}

interface PrincipalRow {
  readonly principal_id: string;
  readonly status: string;
  readonly tenant_id: string;
}

interface AuthoritativeContext {
  readonly activePrincipalIds: ReadonlySet<string>;
  readonly legalEntityId: string;
  readonly tenantId: string;
}

interface ContextMigrationResult {
  readonly deleted: number;
  readonly touched: number;
}

interface ContactsAuthorizationMigrationResult {
  readonly contexts: number;
  readonly deleted: number;
  readonly touched: number;
}

type SpiceDbClient = ReturnType<typeof v1.NewClient>;

const migrationFailure = (message: string): ContactsAuthorizationMigrationError =>
  new ContactsAuthorizationMigrationError({ message });

const relationshipKey = (relationship: ContactsAuthorizationRelationship): string =>
  `${relationship.relation}\0${relationship.subjectType}\0${relationship.subjectId}`;

const sameRelationshipSet = (
  left: readonly ContactsAuthorizationRelationship[],
  right: readonly ContactsAuthorizationRelationship[],
): boolean => {
  const leftKeys = new Set(left.map(relationshipKey));
  const rightKeys = new Set(right.map(relationshipKey));
  return leftKeys.size === rightKeys.size && [...leftKeys].every((key) => rightKeys.has(key));
};

const planContactsAuthorizationContextResult = (
  mode: ContactsAuthorizationMigrationMode,
  legacy: readonly ContactsAuthorizationRelationship[],
  contacts: readonly ContactsAuthorizationRelationship[],
): Result.Result<ContactsAuthorizationContextPlan, ContactsAuthorizationMigrationError> => {
  if (legacy.length === 0 && contacts.length === 0) {
    return Result.succeed({ deleteLegacy: false, state: 'unconfigured', touchContacts: false });
  }
  if (legacy.length === 0) {
    return Result.succeed({
      deleteLegacy: false,
      state: 'already_finalized',
      touchContacts: false,
    });
  }
  if (contacts.length === 0) {
    if (mode !== 'prepare') {
      return Result.fail(
        migrationFailure(
          'Contacts authorization is missing while legacy authorization still exists',
        ),
      );
    }
    return Result.succeed({ deleteLegacy: false, state: 'legacy_only', touchContacts: true });
  }
  if (!sameRelationshipSet(legacy, contacts)) {
    return Result.fail(migrationFailure('Legacy and Contacts authorization relationships differ'));
  }
  return Result.succeed({
    deleteLegacy: mode === 'finalize',
    state: 'already_prepared',
    touchContacts: false,
  });
};

export const planContactsAuthorizationContext = (
  mode: ContactsAuthorizationMigrationMode,
  legacy: readonly ContactsAuthorizationRelationship[],
  contacts: readonly ContactsAuthorizationRelationship[],
): ContactsAuthorizationContextPlan =>
  Result.getOrThrow(planContactsAuthorizationContextResult(mode, legacy, contacts));

const acquirePool = (connection: Redacted.Redacted) =>
  Effect.acquireRelease(
    Effect.try({
      catch: () => migrationFailure('The authorization migration database pool could not open'),
      try: () => new Pool({ connectionString: Redacted.value(connection), max: 1 }),
    }),
    (pool) => Effect.promise(async () => await pool.end()),
  );

const loadAuthoritativeContexts = (
  connection: Redacted.Redacted,
): Effect.Effect<AuthoritativeContext[], ContactsAuthorizationMigrationError> =>
  Effect.gen(function* loadAuthoritativeContextsEffect() {
    const pool = yield* acquirePool(connection);
    const contextResult = yield* Effect.tryPromise({
      catch: () => migrationFailure('The authoritative module contexts could not be read'),
      try: async () =>
        await pool.query<DatabaseContextRow>(
          `select
             legal_entity.legal_entity_id::text,
             module_state.module_key,
             module_state.tenant_id::text
           from core.tenant_module_states as module_state
           join core.legal_entities as legal_entity
             on legal_entity.tenant_id = module_state.tenant_id
           where module_state.module_key in ($1, $2)
           order by module_state.tenant_id, legal_entity.legal_entity_id
           limit $3`,
          [LEGACY_MODULE_ID, CONTACTS_MODULE_ID, MAX_CONTEXTS + 1],
        ),
    });
    if (contextResult.rows.length > MAX_CONTEXTS) {
      return yield* migrationFailure(
        `Authorization migration exceeds the ${MAX_CONTEXTS}-context safety bound`,
      );
    }
    if (contextResult.rows.some((row) => row.module_key === LEGACY_MODULE_ID)) {
      return yield* migrationFailure(
        'Core module identity migration must complete before authorization migration',
      );
    }
    const tenantIds = [...new Set(contextResult.rows.map((row) => row.tenant_id))];
    if (tenantIds.length === 0) {
      return [];
    }
    const principalResult = yield* Effect.tryPromise({
      catch: () => migrationFailure('The authoritative Principals could not be read'),
      try: async () =>
        await pool.query<PrincipalRow>(
          `select principal_id::text, status, tenant_id::text
           from core.principals
           where tenant_id = any($1::uuid[])
           order by tenant_id, principal_id
           limit $2`,
          [tenantIds, MAX_PRINCIPALS + 1],
        ),
    });
    if (principalResult.rows.length > MAX_PRINCIPALS) {
      return yield* migrationFailure(
        `Authorization migration exceeds the ${MAX_PRINCIPALS}-principal safety bound`,
      );
    }
    const activePrincipalsByTenant = new Map<string, Set<string>>();
    for (const principal of principalResult.rows) {
      if (principal.status === 'active') {
        const ids = activePrincipalsByTenant.get(principal.tenant_id) ?? new Set<string>();
        ids.add(principal.principal_id);
        activePrincipalsByTenant.set(principal.tenant_id, ids);
      }
    }
    return contextResult.rows.map((row) => ({
      activePrincipalIds: activePrincipalsByTenant.get(row.tenant_id) ?? new Set<string>(),
      legalEntityId: row.legal_entity_id,
      tenantId: row.tenant_id,
    }));
  }).pipe(Effect.scoped);

const hasExpectedRelationshipEnvelope = (
  relationship: v1.Relationship,
  resourceId: string,
): boolean =>
  relationship.subject !== undefined &&
  relationship.subject.object !== undefined &&
  relationship.subject.optionalRelation === '' &&
  relationship.resource !== undefined &&
  relationship.resource.objectId === resourceId &&
  relationship.resource.objectType === 'module_access' &&
  relationship.optionalCaveat === undefined &&
  relationship.optionalExpiresAt === undefined;

const matchesRelationshipSubject = (
  relation: string,
  subjectType: string | undefined,
  expectedRelation: ContactsAuthorizationRelationship['relation'],
): boolean =>
  relation === expectedRelation &&
  subjectType === (expectedRelation === 'accessor' ? 'principal' : 'legal_entity');

const decodeRelationship = (
  relationship: v1.Relationship | undefined,
  resourceId: string,
  legalEntityObjectId: string,
  activePrincipalIds: ReadonlySet<string>,
): Result.Result<ContactsAuthorizationRelationship, ContactsAuthorizationMigrationError> => {
  if (relationship === undefined) {
    return Result.fail(migrationFailure(OUTSIDE_AUTHORITATIVE_CONTEXT_MESSAGE));
  }
  if (!hasExpectedRelationshipEnvelope(relationship, resourceId)) {
    return Result.fail(migrationFailure(OUTSIDE_AUTHORITATIVE_CONTEXT_MESSAGE));
  }
  const subjectId = relationship.subject?.object?.objectId ?? '';
  const subjectType = relationship.subject?.object?.objectType;
  const { relation } = relationship;
  const isLegalEntity =
    matchesRelationshipSubject(relation, subjectType, 'legal_entity') &&
    subjectId === legalEntityObjectId;
  const isAccessor =
    matchesRelationshipSubject(relation, subjectType, 'accessor') &&
    activePrincipalIds.has(subjectId);
  if (isLegalEntity) {
    return Result.succeed({ relation: 'legal_entity', subjectId, subjectType: 'legal_entity' });
  }
  if (isAccessor) {
    return Result.succeed({ relation: 'accessor', subjectId, subjectType: 'principal' });
  }
  return Result.fail(migrationFailure(OUTSIDE_AUTHORITATIVE_CONTEXT_MESSAGE));
};

const readRelationships = (
  client: SpiceDbClient,
  resourceId: string,
  context: AuthoritativeContext,
): Effect.Effect<ContactsAuthorizationRelationship[], ContactsAuthorizationMigrationError> =>
  Effect.gen(function* readRelationshipsEffect() {
    const responses = yield* Effect.tryPromise({
      catch: () => migrationFailure('Module-access relationships could not be read'),
      try: async () =>
        await client.promises.readRelationships(
          v1.ReadRelationshipsRequest.create({
            consistency: fullyConsistent,
            optionalLimit: MAX_RELATIONSHIPS_PER_CONTEXT + 1,
            relationshipFilter: v1.RelationshipFilter.create({
              optionalResourceId: resourceId,
              resourceType: 'module_access',
            }),
          }),
        ),
    });
    if (responses.length > MAX_RELATIONSHIPS_PER_CONTEXT) {
      return yield* migrationFailure(
        'A module-access context exceeds the relationship safety bound',
      );
    }
    const legalEntityObjectId = toLegalEntityAccessObjectId(
      context.tenantId,
      context.legalEntityId,
    );
    if (legalEntityObjectId === undefined) {
      return yield* migrationFailure('Invalid authoritative legal-entity context');
    }
    return yield* Effect.forEach(
      responses,
      ({ relationship }) =>
        Effect.fromResult(
          decodeRelationship(
            relationship,
            resourceId,
            legalEntityObjectId,
            context.activePrincipalIds,
          ),
        ),
      { concurrency: 'unbounded' },
    );
  });

const toRelationship = (
  resourceId: string,
  item: ContactsAuthorizationRelationship,
): v1.Relationship =>
  v1.Relationship.create({
    relation: item.relation,
    resource: v1.ObjectReference.create({ objectId: resourceId, objectType: 'module_access' }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({
        objectId: item.subjectId,
        objectType: item.subjectType,
      }),
    }),
  });

const writeRelationships = (
  client: SpiceDbClient,
  operation: v1.RelationshipUpdate_Operation,
  resourceId: string,
  relationships: readonly ContactsAuthorizationRelationship[],
): Effect.Effect<void, ContactsAuthorizationMigrationError> => {
  if (relationships.length === 0) {
    return Effect.void;
  }
  return Effect.tryPromise({
    catch: () => migrationFailure('Module-access relationships could not be written'),
    try: async () =>
      await client.promises.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: relationships.map((item) =>
            v1.RelationshipUpdate.create({
              operation,
              relationship: toRelationship(resourceId, item),
            }),
          ),
        }),
      ),
  }).pipe(Effect.asVoid);
};

const checkContactsPermission = (
  client: SpiceDbClient,
  resourceId: string,
  principalId: string,
): Effect.Effect<v1.CheckPermissionResponse_Permissionship, ContactsAuthorizationMigrationError> =>
  Effect.tryPromise({
    catch: () => migrationFailure('Contacts permission verification could not complete'),
    try: async () =>
      await client.promises.checkPermission(
        v1.CheckPermissionRequest.create({
          consistency: fullyConsistent,
          permission: 'access',
          resource: v1.ObjectReference.create({
            objectId: resourceId,
            objectType: 'module_access',
          }),
          subject: v1.SubjectReference.create({
            object: v1.ObjectReference.create({ objectId: principalId, objectType: 'principal' }),
          }),
        }),
      ),
  }).pipe(Effect.map((response) => response.permissionship));

const assertContactsPermissions = (
  client: SpiceDbClient,
  resourceId: string,
  relationships: readonly ContactsAuthorizationRelationship[],
): Effect.Effect<void, ContactsAuthorizationMigrationError> =>
  Effect.gen(function* assertContactsPermissionsEffect() {
    const accessorIds = relationships
      .filter((item) => item.relation === 'accessor')
      .map((item) => item.subjectId);
    yield* Effect.forEach(
      accessorIds,
      (principalId) =>
        checkContactsPermission(client, resourceId, principalId).pipe(
          Effect.filterOrFail(
            (permissionship) =>
              permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
            () =>
              migrationFailure(
                'Contacts permission verification did not preserve an allowed principal',
              ),
          ),
        ),
      { concurrency: 1, discard: true },
    );
    const deniedPermissionship = yield* checkContactsPermission(
      client,
      resourceId,
      DENIED_PROBE_PRINCIPAL_ID,
    );
    if (deniedPermissionship !== v1.CheckPermissionResponse_Permissionship.NO_PERMISSION) {
      yield* migrationFailure(
        'Contacts permission verification did not preserve the denied boundary',
      );
    }
  });

const deleteLegacyRelationships = (
  client: SpiceDbClient,
  resourceId: string,
  relationships: readonly ContactsAuthorizationRelationship[],
  context: AuthoritativeContext,
) =>
  Effect.gen(function* deleteLegacyRelationshipsEffect() {
    yield* writeRelationships(
      client,
      v1.RelationshipUpdate_Operation.DELETE,
      resourceId,
      relationships,
    );
    const remaining = yield* readRelationships(client, resourceId, context);
    if (remaining.length > 0) {
      yield* migrationFailure('Legacy relationship cleanup was incomplete');
    }
  });

const migrateContext = (
  client: SpiceDbClient,
  mode: ContactsAuthorizationMigrationMode,
  context: AuthoritativeContext,
): Effect.Effect<ContextMigrationResult, ContactsAuthorizationMigrationError> =>
  Effect.gen(function* migrateContextEffect() {
    const legacyResourceId = toModuleAccessObjectId(
      context.tenantId,
      context.legalEntityId,
      LEGACY_MODULE_ID,
    );
    const contactsResourceId = toModuleAccessObjectId(
      context.tenantId,
      context.legalEntityId,
      CONTACTS_MODULE_ID,
    );
    if (legacyResourceId === undefined || contactsResourceId === undefined) {
      return yield* migrationFailure('Invalid authoritative module-access context');
    }
    const [legacy, contactsBefore] = yield* Effect.all(
      [
        readRelationships(client, legacyResourceId, context),
        readRelationships(client, contactsResourceId, context),
      ],
      { concurrency: 'unbounded' },
    );
    const plan = yield* Effect.fromResult(
      planContactsAuthorizationContextResult(mode, legacy, contactsBefore),
    );
    if (plan.touchContacts) {
      yield* writeRelationships(
        client,
        v1.RelationshipUpdate_Operation.TOUCH,
        contactsResourceId,
        legacy,
      );
    }
    const contactsAfter = yield* readRelationships(client, contactsResourceId, context);
    if (legacy.length > 0 && !sameRelationshipSet(legacy, contactsAfter)) {
      return yield* migrationFailure('Contacts relationship verification failed after preparation');
    }
    if (contactsAfter.length > 0) {
      yield* assertContactsPermissions(client, contactsResourceId, contactsAfter);
    }
    if (plan.deleteLegacy) {
      yield* deleteLegacyRelationships(client, legacyResourceId, legacy, context);
    }
    return {
      deleted: plan.deleteLegacy ? legacy.length : 0,
      touched: plan.touchContacts ? legacy.length : 0,
    };
  });

const acquireSpiceDbClient = (configuration: SpiceDbConfigValue) =>
  Effect.acquireRelease(
    Effect.try({
      catch: () => migrationFailure('The authorization migration SpiceDB client could not open'),
      try: () =>
        v1.NewClient(
          configuration.preSharedKey,
          configuration.endpoint,
          spiceDbClientSecurity(configuration),
        ),
    }),
    (client) => Effect.sync(() => client.close()),
  );

const migrateContactsAuthorizationEffect = (
  mode: ContactsAuthorizationMigrationMode,
): Effect.Effect<ContactsAuthorizationMigrationResult, ContactsAuthorizationMigrationError> =>
  Effect.gen(function* migrateContactsAuthorizationProgram() {
    const [database, spiceDb] = yield* Effect.all(
      [
        loadDatabaseConnectionPair().pipe(
          Effect.mapError((error) => migrationFailure(error.reason)),
        ),
        loadSpiceDbConfig().pipe(Effect.mapError((error) => migrationFailure(error.reason))),
      ],
      { concurrency: 'unbounded' },
    );
    const contexts = yield* loadAuthoritativeContexts(
      Redacted.make(database.admin.connectionString),
    );
    const client = yield* acquireSpiceDbClient(spiceDb);
    const contextResults = yield* Effect.forEach(
      contexts,
      (context) => migrateContext(client, mode, context),
      { concurrency: 1 },
    );
    return {
      contexts: contextResults.length,
      deleted: EffectNumber.sumAll(contextResults.map((result) => result.deleted)),
      touched: EffectNumber.sumAll(contextResults.map((result) => result.touched)),
    };
  }).pipe(Effect.scoped);

const migrationRuntime = ManagedRuntime.make(NodeServices.layer);

const command = Command.make(
  'migrate-contacts-authorization',
  { mode: Argument.choice('mode', ['prepare', 'verify', 'finalize']) },
  ({ mode }) =>
    Effect.gen(function* migrateContactsAuthorizationCommand() {
      const result = yield* migrateContactsAuthorizationEffect(mode).pipe(
        Effect.tapError((error) => Console.error(error.message)),
      );
      yield* Console.log(
        `Contacts authorization ${mode} completed (${result.contexts} contexts, ${result.touched} touched, ${result.deleted} deleted)`,
      );
    }),
);

const [, invokedPath] = process.argv;
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const exit = await migrationRuntime.runPromiseExit(Command.run(command, { version: '1.0.0' }));
  process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
}
