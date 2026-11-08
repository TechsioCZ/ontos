import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Clock, Context, Crypto, DateTime, Effect, Exit, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { AccessEnforcementPortsLive } from '../../src/actions/runtime-wiring.ts';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../../src/access/bootstrap/index.ts';
import { legalEntityScopeId, tenantContextScopeId } from '../../src/access/bootstrap/persistence.ts';
import { AccessChangesStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import type { AccessDecision } from '../../src/access/decision/contract.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import type { LegalEntityId, PrincipalId, TenantId } from '../../src/access/ids.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import { AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import { TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import { accessPortalWritesForTransaction } from '../../src/access/portal/portal-access.ts';
import type {
  AccessPortalError,
  AccessPortalGrantInput,
  AccessPortalWrites,
} from '../../src/access/portal/portal-access.ts';
import { AccessPortalProjection } from '../../src/access/portal/portal-projection.ts';
import { defineAccessPortalRole } from '../../src/access/portal/portal-role.ts';
import {
  AccessPortalAdmissions,
  AccessPortalAdmissionsLive,
  AccessPortalProjectionLive,
} from '../../src/access/portal/runtime.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessCatalogModule, AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { installOperationalScope } from '../../src/db/scoped-transaction.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import {
  createTemplateDatabase,
  insertTenantStatement,
  replacedDatabase,
} from '../support/access-scenarios/database.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

/*
 * A portal person's access, written by Core alone (`access/portal`). A tenant is bootstrapped by its owner; a
 * customer starts with no access at all. When the owner module's grant becomes ACTIVE, Core gives the customer
 * a membership in the tenant and the company and the module's portal role there, in the module's own
 * transaction, and the real gate allows the role's capabilities once the single writer projected them. Every
 * claim carries its negative control: a capability outside the role, a revoked grant, a membership somebody
 * else recorded, and the refusals that keep a machine, a stranger or an unreleased role out.
 */
const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const MODULE = 'shop.portal';
const PROFILE_READ = 'shop.portal.profile.read';
const ORDER_REPEAT = 'shop.portal.order.repeat';
const ORDER_CANCEL = 'shop.portal.order.cancel';

const entrypoint = (key: string, access: 'read' | 'write') =>
  defineTenantModuleEntrypoint({
    access,
    authorization: { kind: 'protected' },
    entrypointKey: key,
    moduleKey: MODULE,
    role: access === 'read' ? 'api' : 'action',
  });
const declaration = (key: string, kind: 'action' | 'read'): AccessDeclarationInput => ({
  key,
  kind,
  modes: kind === 'read' ? ['run'] : ['run', 'propose'],
  placement: { group: 'portal', level: 'basic' },
  risk: 'sensitive',
  selectors: [],
});

const profileRead = declaration(PROFILE_READ, 'read');
const orderRepeat = declaration(ORDER_REPEAT, 'action');
const orderCancel = declaration(ORDER_CANCEL, 'action');
const profileReadEntrypoint = entrypoint('shop.portal.api.profile-read', 'read');
const orderRepeatEntrypoint = entrypoint('shop.portal.order-repeat', 'write');
const orderCancelEntrypoint = entrypoint('shop.portal.order-cancel', 'write');
const modules: readonly AccessCatalogModule[] = [
  {
    descriptors: [
      { accessDeclaration: profileRead, entrypoint: profileReadEntrypoint },
      { accessDeclaration: orderRepeat, entrypoint: orderRepeatEntrypoint },
      { accessDeclaration: orderCancel, entrypoint: orderCancelEntrypoint },
    ],
    moduleId: MODULE,
  },
];
const profileReadCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(profileRead, profileReadEntrypoint) };
const orderCancelCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(orderCancel, orderCancelEntrypoint) };

const customerRole = defineAccessPortalRole({
  capabilities: [PROFILE_READ, ORDER_REPEAT],
  key: 'shop.portal.customer',
  moduleKey: MODULE,
  name: 'Zákazník',
});
const unreleasedRole = defineAccessPortalRole({
  capabilities: ['shop.portal.ghost.read'],
  key: 'shop.portal.ghost',
  moduleKey: MODULE,
  name: 'Duch',
});

const owner = PrincipalIdSchema.make(uid(2));
const customer = PrincipalIdSchema.make(uid(3));
const storefront = PrincipalIdSchema.make(uid(4));
const stranger = PrincipalIdSchema.make(uid(5));
const company = LegalEntityIdSchema.make(uid(6));
const unscopedCompany = LegalEntityIdSchema.make(uid(7));

/** The tenant as the product creates it: identity rows and one installed module, never any access. */
const seedTenant = (admin: PgClient.PgClient, tenantId: TenantId) =>
  Effect.forEach(
    [
      insertTenantStatement(tenantId),
      `insert into core.legal_entities
         (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values
         ('${company}', '${tenantId}', 'Obchod s.r.o.', 'CZ', '12345678', 'active'),
         ('${unscopedCompany}', '${tenantId}', 'Sklad s.r.o.', 'CZ', '87654321', 'active')`,
      `insert into core.principals (tenant_id, principal_id, kind, display_name, status) values
         ('${tenantId}', '${owner}', 'human', 'Vlastník', 'active'),
         ('${tenantId}', '${customer}', 'human', 'Zákazník', 'active'),
         ('${tenantId}', '${storefront}', 'service', 'Storefront', 'active')`,
      `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state) values
         ('${uid(8)}', '${tenantId}', '${MODULE}', 'active')`,
    ],
    (statement) => admin.unsafe(statement).pipe(Effect.orDie),
    { concurrency: 1, discard: true },
  );

/** One trusted request scope: the acting principal, the tenant and, when given, the selected company (O66). */
const scopeFor = (tenantId: TenantId, principalId: PrincipalId, legalEntityId?: LegalEntityId) => {
  const session = {
    authBindingId: uid(300),
    authContextRef: 'session:access-portal:1',
    authMethod: 'session' as const,
    principalId,
    tenantId,
  };
  return Schema.decodeEffect(TrustedPrincipalContextSchema)(
    legalEntityId === undefined ? session : { ...session, legalEntityId },
  ).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-portal' }) satisfies OperationalScope),
    Effect.orDie,
  );
};

interface Tenant {
  readonly admin: PgClient.PgClient;
  readonly admissions: (typeof AccessPortalAdmissions)['Service'];
  readonly executor: CoreDatabaseExecutor;
  readonly gate: (typeof AccessDecisionGate)['Service'];
  readonly projection: (typeof AccessPortalProjection)['Service'];
  readonly tenantId: TenantId;
}

/**
 * One tenant of this suite's own: a database with the committed schema, the identity rows of a real tenant
 * bootstrapped by its owner, and a SpiceDB carrying the v2 schema.
 */
const withTenant = <Value, Failure>(run: (tenant: Tenant) => Effect.Effect<Value, Failure>) =>
  Effect.gen(function* tenantScenario() {
    const connections = yield* loadDatabaseConnectionPair();
    const crypto = yield* Crypto.Crypto;
    const configuration = yield* loadSpiceDbConfig();
    const bootstrapConnection = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
    const database = `access_portal_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
    yield* bootstrapConnection.unsafe(`create database "${database}"`).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      bootstrapConnection.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie),
    );
    const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
      maxConnections: 2,
    });
    yield* createTemplateDatabase(admin);
    const tenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
    yield* seedTenant(admin, tenantId);
    const runtime = yield* makeTestPgClient(replacedDatabase(connections.runtime.connectionString, database), {
      maxConnections: 3,
    });
    const executor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
    yield* Effect.acquireUseRelease(
      Effect.sync(() => newSpiceDbGrpcClient(configuration)),
      (client) =>
        Effect.tryPromise(() =>
          client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
        ).pipe(Effect.orDie),
      (client) => Effect.sync(() => client.close()),
    );
    const compiler = makeAccessProjectionCompiler(makeAccessProjectionTransport(configuration));
    const platforms = Layer.mergeAll(
      Layer.succeed(CoreDatabase, { executor }),
      Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
      Layer.succeed(AccessProjectionCompiler, compiler),
      NodeServices.layer,
    );
    const stores = Layer.mergeAll(
      platforms,
      TenantIntentLoaderLive.pipe(Layer.provide(platforms)),
      AccessWriteJournalStoreLive.pipe(Layer.provide(platforms)),
      AccessChangesStoreLive.pipe(Layer.provide(platforms)),
    );
    const base = Layer.mergeAll(
      stores,
      AccessMembershipStoreLive.pipe(Layer.provide(platforms)),
      AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores)),
      AccessProjectionWriterLive.pipe(Layer.provide(stores)),
    );
    const context = yield* Layer.build(
      Layer.mergeAll(
        base,
        TenantAccessBootstrapLive.pipe(Layer.provide(base)),
        AccessDecisionLive.pipe(Layer.provide(AccessEnforcementPortsLive), Layer.provide(base)),
        AccessPortalProjectionLive.pipe(Layer.provide(base)),
        AccessPortalAdmissionsLive.pipe(Layer.provide(platforms)),
      ),
    );
    // The owner's bootstrap is the only access the tenant starts with: the release, the scopes and its role.
    yield* Context.get(context, TenantAccessBootstrap)
      .bootstrapTenantAccess({ legalEntityIds: [company], modules, scope: yield* scopeFor(tenantId, owner) })
      .pipe(
        Effect.mapError((cause) => new Error(`${cause.code}: ${cause.reason}`)),
        Effect.orDie,
      );
    return yield* run({
      admin,
      admissions: Context.get(context, AccessPortalAdmissions),
      executor,
      gate: Context.get(context, AccessDecisionGate),
      projection: Context.get(context, AccessPortalProjection),
      tenantId,
    });
  }).pipe(Effect.scoped);

/** The instant the gate decides at: after every row the write path records, so no case reads a clock. */
const decisionAt = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z'));

const decide = (
  tenant: Tenant,
  carrier: typeof profileReadCarrier,
  principalId: PrincipalId,
): Effect.Effect<AccessDecision> =>
  Effect.flatMap(scopeFor(tenant.tenantId, principalId, company), (scope) =>
    tenant.gate.decide({ carrier, legalEntityScope: 'required', now: decisionAt, scope }),
  );

/** The portal writes of one owner transaction, run under the acting principal's scope as an owner Action runs. */
const inOwnerTransaction = <Value>(
  tenant: Tenant,
  actor: PrincipalId,
  write: (writes: AccessPortalWrites) => Effect.Effect<Value, AccessPortalError>,
) =>
  Effect.flatMap(scopeFor(tenant.tenantId, actor, company), (scope) =>
    tenant.executor
      .transaction((transaction) =>
        installOperationalScope(transaction, scope, FIXTURE_DATABASE_IDENTITY_ENROLLMENT).pipe(
          Effect.orDie,
          Effect.flatMap((scoped) => write(accessPortalWritesForTransaction(scoped, scope))),
        ),
      )
      .pipe(Effect.catchTag('SqlError', Effect.die)),
  );

/** One grant the owner makes, answered as its exit so a refusal can be read as data. */
const grantExit = (tenant: Tenant, input: AccessPortalGrantInput) =>
  inOwnerTransaction(tenant, owner, (writes) => writes.grant(input)).pipe(Effect.exit);

const grantOf = (source: string, input: Partial<AccessPortalGrantInput> = {}): AccessPortalGrantInput => ({
  legalEntityId: company,
  principalId: customer,
  role: customerRole,
  source,
  ...input,
});

interface IntentRow extends Record<string, unknown> {
  readonly by: string;
  readonly scope_id: string;
  readonly status: string;
}

const membershipsOf = (tenant: Tenant, principalId: PrincipalId) =>
  tenant.admin
    .unsafe<IntentRow>(
      `select scope_id::text, status, recorded_by::text as by from core.access_memberships
        where tenant_id = '${tenant.tenantId}' and principal_id = '${principalId}' order by created_at, scope_id`,
    )
    .pipe(Effect.orDie);
const assignmentsOf = (tenant: Tenant, principalId: PrincipalId) =>
  tenant.admin
    .unsafe<IntentRow>(
      `select scope_id::text, status, assigned_by::text as by from core.access_assignments
        where tenant_id = '${tenant.tenantId}' and principal_id = '${principalId}' order by valid_from`,
    )
    .pipe(Effect.orDie);

/** Runs one write at a fixed later instant, as a request made then would. */
const runAt = (instant: Date) => {
  const millis = () => instant.getTime();
  const nanos = () => BigInt(instant.getTime()) * 1_000_000n;
  return <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
    Clock.clockWith((clock) =>
      effect.pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeMillis: Effect.sync(millis),
          currentTimeMillisUnsafe: millis,
          currentTimeNanos: Effect.sync(nanos),
          currentTimeNanosUnsafe: nanos,
          monotonicTimeNanos: clock.monotonicTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          sleep: (duration) => clock.sleep(duration),
        }),
      ),
    );
};

const portalRefusalCode = <Value>(exit: Exit.Exit<Value, AccessPortalError>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.flatMap((reason) => ('error' in reason ? [reason.error.code] : [])) : [];

it.layer(NodeServices.layer)('portal access written by Core', (suite) => {
  suite.effect('gives a granted customer its portal role, ends it with the grant, and grants it afresh later', () =>
    withTenant((tenant) =>
      Effect.gen(function* grantsAndRevokes() {
        const tenantScope = tenantContextScopeId(tenant.tenantId);
        const companyScope = legalEntityScopeId(tenant.tenantId, company);
        expect((yield* decide(tenant, profileReadCarrier, customer)).outcome).toBe('DENIED');

        // A machine acting for the customer, as the Storefront enrollment does: the rows are the customer's own.
        const granted = yield* inOwnerTransaction(tenant, storefront, (writes) => writes.grant(grantOf('binding:1:1')));
        expect(granted.changed).toBe(true);
        expect(yield* membershipsOf(tenant, customer)).toEqual(
          [
            { by: customer, scope_id: companyScope, status: 'active' },
            { by: customer, scope_id: tenantScope, status: 'active' },
          ].toSorted((left, right) => left.scope_id.localeCompare(right.scope_id)),
        );
        expect(yield* assignmentsOf(tenant, customer)).toEqual([
          { by: customer, scope_id: companyScope, status: 'active' },
        ]);

        // The same source again is a replay: nothing new is written.
        const replayed = yield* inOwnerTransaction(tenant, storefront, (writes) =>
          writes.grant(grantOf('binding:1:1')),
        );
        expect(replayed).toEqual({ assignmentIncarnationId: granted.assignmentIncarnationId, changed: false });
        expect(yield* assignmentsOf(tenant, customer)).toHaveLength(1);

        yield* tenant.projection.project(yield* scopeFor(tenant.tenantId, owner));
        expect((yield* decide(tenant, profileReadCarrier, customer)).outcome).toBe('ALLOWED');
        // The role opens its own capabilities and nothing else of the module.
        expect((yield* decide(tenant, orderCancelCarrier, customer)).outcome).toBe('DENIED');

        // The grant ends: its assignment and the memberships Core wrote for it end with it, at the commit.
        const revoked = yield* inOwnerTransaction(tenant, storefront, (writes) =>
          writes.revoke(grantOf('binding:1:1')),
        );
        expect(revoked).toEqual({ assignmentIncarnationId: granted.assignmentIncarnationId, changed: true });
        expect((yield* assignmentsOf(tenant, customer)).map(({ status }) => status)).toEqual(['revoked']);
        expect((yield* membershipsOf(tenant, customer)).map(({ status }) => status)).toEqual(['revoked', 'revoked']);
        // The decision reads the intent first, so the revocation holds before the engine follows.
        expect((yield* decide(tenant, profileReadCarrier, customer)).outcome).toBe('DENIED');
        const revokedAgain = yield* inOwnerTransaction(tenant, storefront, (writes) =>
          writes.revoke(grantOf('binding:1:1')),
        );
        expect(revokedAgain.changed).toBe(false);

        // A later grant is a fresh incarnation with fresh memberships; nothing ended is revived (D27).
        const regranted = yield* inOwnerTransaction(tenant, storefront, (writes) =>
          writes.grant(grantOf('binding:1:3')),
        );
        expect(regranted.changed).toBe(true);
        expect(regranted.assignmentIncarnationId).not.toBe(granted.assignmentIncarnationId);
        expect((yield* membershipsOf(tenant, customer)).map(({ status }) => status).toSorted()).toEqual([
          'active',
          'active',
          'revoked',
          'revoked',
        ]);
        yield* tenant.projection.project(yield* scopeFor(tenant.tenantId, owner));
        expect((yield* decide(tenant, profileReadCarrier, customer)).outcome).toBe('ALLOWED');
      }),
    ),
  );

  suite.effect('keeps a membership somebody else recorded and attributes a person’s own grant to that person', () =>
    withTenant((tenant) =>
      Effect.gen(function* keepsForeignMembership() {
        // The owner made the customer a member of the company and the tenant beforehand.
        yield* tenant.admin
          .unsafe(`insert into core.access_memberships
              (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, recorded_by) values
              ('${uid(20)}', '${tenant.tenantId}', '${tenantContextScopeId(tenant.tenantId)}', '${customer}', 'member',
               'active', '1970-01-01T00:00:00Z'::timestamptz, '${owner}'),
              ('${uid(21)}', '${tenant.tenantId}', '${legalEntityScopeId(tenant.tenantId, company)}', '${customer}',
               'member', 'active', '1970-01-01T00:00:00Z'::timestamptz, '${owner}')`)
          .pipe(Effect.orDie);
        yield* inOwnerTransaction(tenant, owner, (writes) => writes.grant(grantOf('grant:1')));
        expect((yield* membershipsOf(tenant, customer)).map(({ by }) => by)).toEqual([owner, owner]);
        expect((yield* assignmentsOf(tenant, customer)).map(({ by }) => by)).toEqual([owner]);

        yield* inOwnerTransaction(tenant, owner, (writes) => writes.revoke(grantOf('grant:1')));
        expect((yield* assignmentsOf(tenant, customer)).map(({ status }) => status)).toEqual(['revoked']);
        // Core never ends a membership it did not write.
        expect((yield* membershipsOf(tenant, customer)).map(({ status }) => status)).toEqual(['active', 'active']);
      }),
    ),
  );

  suite.effect('writes a membership beside one whose time ran out, so the portal person can act', () =>
    withTenant((tenant) =>
      Effect.gen(function* replacesExpiredMembership() {
        // An earlier membership of the customer lapsed by time while its status still reads `active`.
        yield* tenant.admin
          .unsafe(`insert into core.access_memberships
              (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, valid_until, recorded_by)
              values
              ('${uid(22)}', '${tenant.tenantId}', '${tenantContextScopeId(tenant.tenantId)}', '${customer}', 'member',
               'active', '1970-01-01T00:00:00Z'::timestamptz, '2030-01-01T00:00:00Z'::timestamptz, '${owner}'),
              ('${uid(23)}', '${tenant.tenantId}', '${legalEntityScopeId(tenant.tenantId, company)}', '${customer}',
               'member', 'active', '1970-01-01T00:00:00Z'::timestamptz, '2030-01-01T00:00:00Z'::timestamptz,
               '${owner}')`)
          .pipe(Effect.orDie);
        const later = DateTime.toDateUtc(DateTime.makeUnsafe('2031-06-01T00:00:00Z'));
        yield* inOwnerTransaction(tenant, customer, (writes) => writes.grant(grantOf('grant:after-lapse'))).pipe(
          runAt(later),
        );
        // The lapsed rows are recorded as ended, and Core wrote the open membership beside each of them.
        expect((yield* membershipsOf(tenant, customer)).map(({ status }) => status).toSorted()).toEqual([
          'active',
          'active',
          'revoked',
          'revoked',
        ]);
      }),
    ),
  );

  suite.effect('keeps the memberships while another grant of the person still lives', () =>
    withTenant((tenant) =>
      Effect.gen(function* keepsSharedMembership() {
        yield* inOwnerTransaction(tenant, customer, (writes) => writes.grant(grantOf('grant:a')));
        yield* inOwnerTransaction(tenant, customer, (writes) => writes.grant(grantOf('grant:b')));
        expect(yield* assignmentsOf(tenant, customer)).toHaveLength(2);
        expect(yield* membershipsOf(tenant, customer)).toHaveLength(2);

        yield* inOwnerTransaction(tenant, customer, (writes) => writes.revoke(grantOf('grant:a')));
        expect((yield* membershipsOf(tenant, customer)).map(({ status }) => status)).toEqual(['active', 'active']);
        yield* tenant.projection.project(yield* scopeFor(tenant.tenantId, owner));
        expect((yield* decide(tenant, profileReadCarrier, customer)).outcome).toBe('ALLOWED');

        yield* inOwnerTransaction(tenant, customer, (writes) => writes.revoke(grantOf('grant:b')));
        expect((yield* membershipsOf(tenant, customer)).map(({ status }) => status)).toEqual(['revoked', 'revoked']);
      }),
    ),
  );

  suite.effect('ends the memberships beside an assignment whose own time ran out', () =>
    withTenant((tenant) =>
      Effect.gen(function* endsBesideLapsed() {
        // An invitee redeemed a claim proof and never claimed: its assignment lapses with the proof, still `active`.
        const validUntil = DateTime.toDateUtc(DateTime.makeUnsafe('2031-01-01T00:00:00Z'));
        yield* inOwnerTransaction(tenant, customer, (writes) =>
          writes.grant(grantOf('invite:lapsing', { validUntil })),
        );
        yield* inOwnerTransaction(tenant, customer, (writes) => writes.grant(grantOf('grant:live')));

        // Later the lapsed row is not live intent, so ending the other grant ends the memberships Core wrote.
        yield* inOwnerTransaction(tenant, customer, (writes) => writes.revoke(grantOf('grant:live'))).pipe(
          runAt(DateTime.toDateUtc(DateTime.makeUnsafe('2031-06-01T00:00:00Z'))),
        );
        expect((yield* membershipsOf(tenant, customer)).map(({ status }) => status)).toEqual(['revoked', 'revoked']);
      }),
    ),
  );

  suite.effect('refuses a machine, a stranger, an unscoped company, an unreleased role and an ended grant', () =>
    withTenant((tenant) =>
      Effect.gen(function* refuses() {
        expect(portalRefusalCode(yield* grantExit(tenant, grantOf('m', { principalId: storefront })))).toEqual([
          'access_portal_principal_not_a_person',
        ]);
        expect(portalRefusalCode(yield* grantExit(tenant, grantOf('s', { principalId: stranger })))).toEqual([
          'access_portal_principal_unknown',
        ]);
        expect(portalRefusalCode(yield* grantExit(tenant, grantOf('c', { legalEntityId: unscopedCompany })))).toEqual([
          'access_portal_scope_missing',
        ]);
        expect(portalRefusalCode(yield* grantExit(tenant, grantOf('r', { role: unreleasedRole })))).toEqual([
          'access_portal_role_unreleased',
        ]);
        expect(
          portalRefusalCode(
            yield* grantExit(tenant, grantOf('e', { validUntil: DateTime.toDateUtc(DateTime.makeUnsafe(0)) })),
          ),
        ).toEqual(['access_portal_grant_expired']);
        // Nothing of a refused grant was written.
        expect(yield* membershipsOf(tenant, customer)).toEqual([]);
        expect(yield* assignmentsOf(tenant, customer)).toEqual([]);
      }),
    ),
  );

  suite.effect('admits a person in a Core transaction of its own and rolls a refused admission back whole', () =>
    withTenant((tenant) =>
      Effect.gen(function* admits() {
        const customerScope = yield* scopeFor(tenant.tenantId, customer, company);
        const refused = yield* tenant.admissions
          .grant(customerScope, grantOf('invite:1', { role: unreleasedRole }))
          .pipe(Effect.exit);
        expect(portalRefusalCode(refused)).toEqual(['access_portal_role_unreleased']);
        expect(yield* membershipsOf(tenant, customer)).toEqual([]);

        const validUntil = DateTime.toDateUtc(DateTime.makeUnsafe('2031-01-01T00:00:00Z'));
        const admitted = yield* tenant.admissions.grant(customerScope, grantOf('invite:1', { validUntil }));
        expect(admitted.changed).toBe(true);
        yield* tenant.projection.project(customerScope);
        expect((yield* decide(tenant, profileReadCarrier, customer)).outcome).toBe('ALLOWED');
        const [assignment] = yield* tenant.admin
          .unsafe<{ readonly valid_until: Date }>(
            `select valid_until from core.access_assignments where incarnation_id = '${admitted.assignmentIncarnationId}'`,
          )
          .pipe(Effect.orDie);
        expect(assignment?.valid_until).toEqual(validUntil);
      }),
    ),
  );
});
