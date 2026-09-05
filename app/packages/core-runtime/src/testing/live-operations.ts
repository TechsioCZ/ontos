/* oxlint-disable perfectionist/sort-object-types, perfectionist/sort-objects, sonarjs/no-undefined-assignment, typescript/no-unsafe-assignment */
// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
/* eslint-disable no-await-in-loop, node/callback-return, promise/prefer-await-to-callbacks -- Sequential disposable setup and Drizzle transaction callbacks preserve real authorization and commit boundaries. */
import { randomUUID } from 'node:crypto';
import { v1 } from '@authzed/authzed-node';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect, Layer } from 'effect';
import { Pool } from 'pg';
import { ActionRuntimeLive } from '../actions/runtime.ts';
import { CoreDatabase } from '../db/client.ts';
import {
  actionInvocations,
  auditEvents,
  dataAccessEvents,
  domainEvents,
  outboxMessages,
  coreRelations,
  tenants,
  legalEntities,
  principals,
  principalAuthBindings,
  tenantModuleStates,
} from '../db/schema.ts';
import {
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '../permissions/context-access.ts';
import { loadSpiceDbConfig } from '../permissions/config.ts';
import { ReadRuntimeLive } from '../reads/runtime.ts';
import { buildActionAuthorizationRelationships } from '../install/action-authorization-provisioning.ts';

const relationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
) =>
  v1.Relationship.create({
    relation,
    resource: { objectId: resourceId, objectType: resourceType },
    subject: { object: { objectId: subjectId, objectType: subjectType } },
  });

/** Real Core persistence and SpiceDB. Call only against a disposable local database. */
export const makeLiveOperationFixture = async (configuration: {
  readonly actionKeys?: readonly string[];
  readonly runtimeConnectionString: string;
}) => {
  const spiceDb = await Effect.runPromise(loadSpiceDbConfig());
  const address = new URL(configuration.runtimeConnectionString);
  if (
    !['localhost', '127.0.0.1'].includes(address.hostname) ||
    !spiceDb.endpoint.startsWith('localhost:')
  ) {
    throw new Error('Live test fixtures require disposable localhost services');
  }
  const pool = new Pool({ connectionString: configuration.runtimeConnectionString, max: 8 });
  const executor = drizzle({ client: pool, relations: coreRelations });
  const spice = v1.NewClient(
    spiceDb.preSharedKey,
    spiceDb.endpoint,
    v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED,
  );
  const tenantId = randomUUID();
  const legalEntityId = randomUUID();
  const actor = () => {
    const authBindingId = randomUUID();
    return {
      authBindingId,
      authContextRef: `better-auth-session:${authBindingId}`,
      authMethod: 'session' as const,
      principalId: randomUUID(),
      tenantId,
    };
  };
  const manager = actor();
  const legalEntityOnly = { ...actor(), legalEntityId };
  const denied = actor();
  try {
    await executor.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Disposable live acceptance',
      slug: `live-${tenantId}`,
      status: 'active',
      tenantId,
    });
    await executor.insert(legalEntities).values({
      legalEntityId,
      legalName: 'Disposable live acceptance',
      registrationCountry: 'CZ',
      registrationNumber: legalEntityId,
      status: 'active',
      tenantId,
    });
    await executor
      .insert(tenantModuleStates)
      .values({ moduleKey: 'party.registry', state: 'active', tenantId });
    for (const principal of [manager, legalEntityOnly, denied]) {
      await executor.insert(principals).values({
        displayName: 'Live actor',
        kind: 'human',
        principalId: principal.principalId,
        status: 'active',
        tenantId,
      });
      await executor.insert(principalAuthBindings).values({
        principalAuthBindingId: principal.authBindingId,
        principalId: principal.principalId,
        provider: 'better_auth',
        providerSubjectId: principal.authBindingId,
        status: 'active',
        subjectType: 'user',
        tenantId,
      });
    }
    const entityObject = toLegalEntityAccessObjectId(tenantId, legalEntityId);
    if (entityObject === undefined) {
      throw new Error('Invalid fixture Legal Entity');
    }
    const relations = [
      ...[manager, legalEntityOnly, denied].map((principal) =>
        relationship('tenant', tenantId, 'member', 'principal', principal.principalId),
      ),
      ...[
        'party_identity_manager',
        'party_identity_reader',
        'party_identity_reviewer',
        'party_relationship_manager',
      ].map((relation) =>
        relationship('tenant', tenantId, relation, 'principal', manager.principalId),
      ),
      relationship('legal_entity', entityObject, 'tenant', 'tenant', tenantId),
      ...[manager, legalEntityOnly].flatMap((principal) =>
        ['member', 'counterparty_manager', 'counterparty_reader'].map((relation) =>
          relationship('legal_entity', entityObject, relation, 'principal', principal.principalId),
        ),
      ),
      ...buildActionAuthorizationRelationships(configuration.actionKeys ?? [], [
        { principalId: manager.principalId, tenantId },
      ]),
    ];
    await spice.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: relations.map((item) =>
          v1.RelationshipUpdate.create({
            operation: v1.RelationshipUpdate_Operation.TOUCH,
            relationship: item,
          }),
        ),
      }),
    );
  } catch (error) {
    spice.close();
    await pool.end();
    throw error;
  }
  let nextFault: 'lost-ack' | 'rollback' | undefined;
  const transactionFault: Pick<typeof executor, 'transaction'> = {
    transaction: async (callback, options) => {
      const fault = nextFault;
      nextFault = undefined;
      const value = await executor.transaction(async (transaction) => {
        const result = await callback(transaction);
        if (fault === 'rollback') {
          throw new Error('Controlled precommit rollback');
        }
        return result;
      }, options);
      if (fault === 'lost-ack') {
        throw Object.assign(new Error('Controlled lost commit acknowledgement'), {
          commitIndeterminate: true,
        });
      }
      return value;
    },
  };
  const faultExecutor: typeof executor = Object.assign(Object.create(executor), transactionFault);
  const layer = Layer.mergeAll(
    ActionRuntimeLive.pipe(Layer.provide(Layer.succeed(CoreDatabase, { executor: faultExecutor }))),
    ReadRuntimeLive.pipe(Layer.provide(Layer.succeed(CoreDatabase, { executor }))),
  );
  return {
    denied,
    evidence: async () => {
      const [invocations, audits, accesses, events, outbox] = await Promise.all([
        executor.select().from(actionInvocations).where(eq(actionInvocations.tenantId, tenantId)),
        executor.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
        executor.select().from(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId)),
        executor.select().from(domainEvents).where(eq(domainEvents.tenantId, tenantId)),
        executor.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
      ]);
      return { invocations, audits, accesses, events, outbox };
    },
    faultNextTransaction: (fault: 'lost-ack' | 'rollback') => {
      nextFault = fault;
    },
    grantResourceAccess: async (
      resource: {
        readonly moduleId: string;
        readonly resourceType: string;
        readonly resourceId: string;
      },
      principalId: string,
      permission: 'reader' | 'writer' = 'reader',
    ) => {
      const entityObject = toLegalEntityAccessObjectId(tenantId, legalEntityId);
      const moduleObject = toModuleAccessObjectId(tenantId, legalEntityId, resource.moduleId);
      const resourceObject = toResourceAccessObjectId(tenantId, legalEntityId, resource);
      if (
        entityObject === undefined ||
        moduleObject === undefined ||
        resourceObject === undefined
      ) {
        throw new Error('Invalid resource fixture');
      }
      const relations = [
        relationship('module_access', moduleObject, 'legal_entity', 'legal_entity', entityObject),
        relationship('module_access', moduleObject, 'accessor', 'principal', principalId),
        relationship('resource', resourceObject, 'module', 'module_access', moduleObject),
        relationship('resource', resourceObject, permission, 'principal', principalId),
      ];
      await spice.promises.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: relations.map((item) =>
            v1.RelationshipUpdate.create({
              operation: v1.RelationshipUpdate_Operation.TOUCH,
              relationship: item,
            }),
          ),
        }),
      );
    },
    layer,
    legalEntityId,
    legalEntityOnly,
    manager,
    tenantId,
    // Retain append-only proof rows until the disposable database is removed.
    close: async () => {
      spice.close();
      await pool.end();
    },
  };
};
