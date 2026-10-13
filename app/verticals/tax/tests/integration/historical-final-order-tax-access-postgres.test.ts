import { randomUUID } from 'node:crypto';

import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import {
  ActionRuntime,
  ActiveApplicationCompositionService,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfig,
  ModuleStateDeniedError,
  ReadHandlerNotFound,
  ReadPermissionDenied,
  ReadRuntime,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
  TrustedPrincipalContextSchema,
  makeActionRuntimeLive,
  parseDatabaseConfig,
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { Config, ConfigProvider, Context, Data, Effect, Layer, Schema, pipe } from 'effect';
import { expect, it } from 'effect-rstest';
import { Client } from 'pg';

import { FinalizeOrderTaxResultSchema } from '../../shared/actions/order-tax-finalization.ts';
import { declareSellerVatRegimeAction } from '../../src/actions/declare-seller-vat-regime.action.ts';
import { finalizeOrderTaxAction } from '../../src/actions/finalize-order-tax.action.ts';
import { finalOrderTaxRead } from '../../src/api/final-order-tax.read.ts';
import { taxEvaluationRead } from '../../src/api/tax-evaluation.read.ts';
import { purchaseBindingInput } from '../unit/tax-domain-fixtures.ts';
import { evaluationRequestInput } from '../unit/tax-evaluation-fixtures.ts';

const T = '2026-06-01T10:00:00.000Z';
const MODULE = 'commerce.tax';
const MessageSchema = Schema.Struct({ message: Schema.String });
const LocalHostSchema = Schema.Literals(['localhost', '127.0.0.1']);
const transport = () => ({ correlationId: randomUUID(), idempotencyKey: randomUUID() });

class HistoricalAccessFixtureError extends Data.TaggedError('HistoricalAccessFixtureError')<{
  readonly cause?: unknown;
  readonly reason: string;
}> {
  override get message(): string {
    return `${this.reason}: ${Schema.is(MessageSchema)(this.cause) ? this.cause.message : String(this.cause)}`;
  }
}

const attempt = <Value>(reason: string, operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({ catch: (cause) => new HistoricalAccessFixtureError({ cause, reason }), try: operation });

const requiredEnvironment = (key: string) =>
  Config.schema(Schema.String.check(Schema.isMinLength(1)), key).parse(ConfigProvider.fromEnv());

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

const AuthoritySchema = Schema.Struct({
  durable_work_admission: Schema.String,
  phase: Schema.String,
  revision: Schema.String,
  subscriptions_json: Schema.Unknown,
  updated_at: Schema.String,
  valid_until: Schema.String,
});

/** Native pg rows cross an unvalidated database boundary before TAX fixture schemas establish their shapes. */
interface HistoricalFixtureDatabaseResult {
  readonly rows: readonly unknown[];
}

/**
 * Native infrastructure bootstrap only: disposable records and exact SpiceDB relationships are admin-created and
 * cleaned up. Authenticated session and validated release publication are fixtures, not a signed/redeemed gateway
 * test. Every business operation below uses the real public Core runtime, SpiceDB, PostgreSQL/RLS and TAX handlers.
 * Foreign purchase inputs remain the named CALLER_SUPPLIED_UNVERIFIED receiving doubles; no owner integration is claimed.
 */
const fixture = Effect.fn('TaxHistoricalAccess.fixture')(function* fixtureEffect() {
  const adminUrl = yield* requiredEnvironment('DATABASE_ADMIN_URL');
  const runtimeUrl = yield* requiredEnvironment('DATABASE_URL');
  const endpoint = yield* requiredEnvironment('SPICEDB_ENDPOINT');
  const key = yield* requiredEnvironment('SPICEDB_PRESHARED_KEY');
  const ca = yield* requiredEnvironment('SPICEDB_CA_CERT');
  const addresses = yield* Effect.forEach([adminUrl, runtimeUrl, `https://${endpoint}`], (address) =>
    Schema.decodeEffect(Schema.URLFromString)(address),
  );
  if (addresses.some((address) => !Schema.is(LocalHostSchema)(address.hostname))) {
    return yield* new HistoricalAccessFixtureError({ reason: 'Native fixture bootstrap requires localhost services' });
  }
  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Client({ connectionString: adminUrl })),
    (client) => attempt('Close historical-access fixture database', () => client.end()).pipe(Effect.orDie),
  );
  yield* attempt('Connect historical-access fixture database', () => admin.connect());
  const query = (statement: string, values: readonly unknown[] = []) =>
    attempt(`Historical-access fixture SQL ${statement.slice(0, 120)}`, () => admin.query(statement, [...values])).pipe(
      // pg does not validate row shapes. Keep them unknown until the owning schema decodes the database boundary.
      Effect.map(({ rows }): HistoricalFixtureDatabaseResult => ({ rows })),
    );
  const spice = yield* Effect.acquireRelease(
    Effect.sync(() => v1.NewClientWithCustomCert(key, endpoint, Buffer.from(ca))),
    (client) => Effect.sync(() => client.close()),
  );
  const changeRelationships = (items: readonly v1.Relationship[], operation: v1.RelationshipUpdate_Operation) =>
    attempt('Historical-access fixture authorization bootstrap', () =>
      spice.promises.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: items.map((item) => v1.RelationshipUpdate.create({ operation, relationship: item })),
        }),
      ),
    );
  // Share the publication lock used by Core's native suites, and release it even if fixture restoration fails.
  yield* Effect.acquireRelease(
    query("SELECT pg_advisory_lock(hashtextextended('ontos.search-test-authority', 0))"),
    () => query("SELECT pg_advisory_unlock(hashtextextended('ontos.search-test-authority', 0))").pipe(Effect.orDie),
  );
  const deployment = { appId: 'tax', buildMarker: `historical-access-${randomUUID()}` };
  const snapshot = yield* makeApplicationCompositionSnapshotFixture([deployment.appId], deployment.buildMarker);
  const previousRows = yield* query('SELECT row_to_json(a) AS authority FROM core.application_composition_authority a');
  const previous = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ authority: AuthoritySchema })))(
    previousRows.rows,
  );
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const sellerId = randomUUID();
  const otherSellerId = randomUUID();
  const foreignSellerId = randomUUID();
  const principalId = randomUUID();
  const foreignPrincipalId = randomUUID();
  const authBindingId = randomUUID();
  const foreignAuthBindingId = randomUUID();
  const ownedRelations: v1.Relationship[] = [];
  let relationshipsWritten = false;
  const tenantIds = [tenantId, otherTenantId];
  // Separate finalizers guarantee tuple cleanup even when database restoration fails.
  yield* Effect.addFinalizer(() =>
    (relationshipsWritten
      ? changeRelationships(ownedRelations, v1.RelationshipUpdate_Operation.DELETE)
      : Effect.void
    ).pipe(Effect.orDie),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* releaseHistoricalAccessFixture() {
      yield* query('BEGIN');
      yield* query('SET LOCAL session_replication_role = replica');
      // Disable append-only/FK triggers only for cleanup of these two fixture tenants, as existing DB tests do.
      const tables = yield* query(
        "SELECT table_schema, table_name FROM information_schema.columns WHERE column_name = 'tenant_id' AND table_schema IN ('core', 'tax')",
      );
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ table_name: Schema.String, table_schema: Schema.String })),
      )(tables.rows);
      yield* Effect.forEach(
        decoded,
        (table) =>
          query(`DELETE FROM "${table.table_schema}"."${table.table_name}" WHERE tenant_id = ANY($1::uuid[])`, [
            tenantIds,
          ]),
        { discard: true },
      );
      yield* query('DELETE FROM core.application_composition_authority WHERE revision = $1', [
        snapshot.composition.revision,
      ]);
      yield* Effect.forEach(
        previous,
        ({ authority }) =>
          query(
            'INSERT INTO core.application_composition_authority (revision, phase, durable_work_admission, valid_until, subscriptions_json, updated_at) VALUES ($1,$2,$3,$4,$5,$6)',
            [
              authority.revision,
              authority.phase,
              authority.durable_work_admission,
              authority.valid_until,
              JSON.stringify(authority.subscriptions_json),
              authority.updated_at,
            ],
          ),
        { discard: true },
      );
      yield* query('COMMIT');
    }).pipe(Effect.orDie),
  );
  yield* query(
    "INSERT INTO core.application_composition_authority (revision,phase,valid_until,subscriptions_json) VALUES ($1,'active',now()+interval '1 hour','[]') ON CONFLICT (authority_key) DO UPDATE SET revision=EXCLUDED.revision,phase='active',durable_work_admission='open',valid_until=EXCLUDED.valid_until,subscriptions_json='[]'",
    [snapshot.composition.revision],
  );
  for (const id of tenantIds) {
    yield* query(
      "INSERT INTO core.tenants (tenant_id,slug,name,status,default_locale) VALUES ($1,$2,'Historical TAX fixture','active','en')",
      [id, `tax-history-${id}`],
    );
    yield* query("INSERT INTO core.tenant_module_states (tenant_id,module_key,state) VALUES ($1,$2,'active')", [
      id,
      MODULE,
    ]);
  }
  const actorScopes = [
    { authBindingId, legalEntityId: sellerId, principalId, tenantId },
    { authBindingId, legalEntityId: otherSellerId, principalId, tenantId },
    {
      authBindingId: foreignAuthBindingId,
      legalEntityId: foreignSellerId,
      principalId: foreignPrincipalId,
      tenantId: otherTenantId,
    },
  ];
  for (const actor of [actorScopes[0], actorScopes[2]]) {
    if (actor === undefined) {
      return yield* new HistoricalAccessFixtureError({ reason: 'Missing fixture actor' });
    }
    yield* query(
      "INSERT INTO core.principals (principal_id,tenant_id,kind,display_name,status) VALUES ($1,$2,'human','Historical TAX fixture','active')",
      [actor.principalId, actor.tenantId],
    );
    yield* query(
      "INSERT INTO core.principal_auth_bindings (principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) VALUES ($1::uuid,$2,$3,$4,'better-auth','user',$1::text,'active')",
      [actor.authBindingId, actor.tenantId, actor.principalId, STAFF_AUTHENTICATION_NAMESPACE_ID],
    );
    ownedRelations.push(relationship('tenant', actor.tenantId, 'member', 'principal', actor.principalId));
  }
  for (const actor of actorScopes) {
    yield* query(
      "INSERT INTO core.legal_entities (legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) VALUES ($1::uuid,$2,'Historical TAX fixture','CZ',$1::text,'active')",
      [actor.legalEntityId, actor.tenantId],
    );
    const entity = toLegalEntityAccessObjectId(actor.tenantId, actor.legalEntityId);
    const module = toModuleAccessObjectId(actor.tenantId, actor.legalEntityId, MODULE);
    const permission = toContextPermissionAccessObjectId(actor.tenantId, actor.legalEntityId, {
      moduleId: MODULE,
      permission: 'tax.governed.read',
    });
    if (entity === undefined || module === undefined || permission === undefined) {
      return yield* new HistoricalAccessFixtureError({ reason: 'Invalid fixture scope' });
    }
    ownedRelations.push(
      relationship('legal_entity', entity, 'tenant', 'tenant', actor.tenantId),
      relationship('legal_entity', entity, 'member', 'principal', actor.principalId),
      relationship('module_access', module, 'legal_entity', 'legal_entity', entity),
      relationship('module_access', module, 'accessor', 'principal', actor.principalId),
      relationship('context_permission', permission, 'tenant', 'tenant', actor.tenantId),
      relationship('context_permission', permission, 'grantee', 'principal', actor.principalId),
    );
  }
  for (const registration of [declareSellerVatRegimeAction, finalizeOrderTaxAction]) {
    ownedRelations.push(
      relationship(
        'action',
        `ak_${Buffer.from(registration.descriptor.actionKey).toString('base64url')}`,
        'executor',
        'principal',
        principalId,
      ),
    );
  }
  relationshipsWritten = true;
  yield* changeRelationships(ownedRelations, v1.RelationshipUpdate_Operation.TOUCH);
  const moduleStates = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
  const stateGate = ModuleStateGateLive.pipe(Layer.provide(moduleStates));
  const gateway = ModuleEntrypointGatewayLive.pipe(Layer.provide(stateGate));
  const resolver = OperationalScopeResolverLive.pipe(
    Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
  );
  const dependencies = Layer.mergeAll(CorePersistenceLive, ContextAccessLive, gateway, resolver);
  const runtimes = Layer.mergeAll(
    ReadRuntimeLive.pipe(Layer.provide(dependencies)),
    makeActionRuntimeLive(deployment).pipe(
      Layer.provide(
        Layer.mergeAll(
          dependencies,
          stateGate,
          ActionPermissionLive,
          ActionRepositoryLive,
          Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
        ),
      ),
    ),
  ).pipe(
    Layer.provide(Layer.succeed(DatabaseConfig, yield* parseDatabaseConfig({ DATABASE_URL: runtimeUrl }))),
    Layer.provideMerge(staffAuthenticationNamespaceRegistryLayer(['tax'])),
    Layer.provide(NodeServices.layer),
  );
  const context = yield* Layer.build(runtimes);
  const reads = Context.get(context, ReadRuntime);
  const actions = Context.get(context, ActionRuntime);
  const principals = yield* pipe(
    actorScopes,
    Effect.forEach((actor) =>
      Schema.decodeEffect(TrustedPrincipalContextSchema)({
        ...actor,
        authContextRef: `better-auth-session:${actor.authBindingId}`,
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        authMethod: 'session',
      }).pipe(
        // Fixture the already-authenticated boundary. Cryptographic assertion verification/redemption is outside this test.
        Effect.map((principal) => trustVerifiedGatewayPrincipalContext(principal, snapshot.composition.revision)),
      ),
    ),
  );
  const [principal] = principals;
  if (principal === undefined) {
    return yield* new HistoricalAccessFixtureError({ reason: 'Missing primary fixture principal' });
  }
  yield* actions
    .runAction({
      audience: 'tax',
      payload: {
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        expectedCurrentRevision: 0,
        reason: 'Disposable historical-access declaration',
        regime: 'NON_PAYER',
      },
      principal,
      registration: declareSellerVatRegimeAction,
      transport: transport(),
    })
    .pipe(Effect.provide(context));
  const input = evaluationRequestInput(
    {
      catalog: [],
      purchase: purchaseBindingInput(['o1'], { sellingLegalEntityRef: sellerId, tenantId }),
      taxRelevantTime: T,
    },
    ['o1'],
  );
  const { taxRelevantTime: _time, ...candidate } = input;
  const payload = {
    candidate,
    orderCommitmentTime: T,
    provenanceRef: 'fixture:historical-access',
    reason: 'Disposable historical-access final',
    submissionRef: `history-${randomUUID()}`,
  };
  const final = yield* actions
    .runAction({
      audience: 'tax',
      payload,
      principal,
      registration: finalizeOrderTaxAction,
      transport: transport(),
    })
    .pipe(Effect.provide(context));
  if (!Schema.is(FinalizeOrderTaxResultSchema.members[0])(final)) {
    return yield* new HistoricalAccessFixtureError({ reason: 'Governed action did not persist a successful final' });
  }
  const readFinal = (selected = principal) =>
    reads
      .runRead({
        audience: 'tax',
        input: { submissionRef: payload.submissionRef },
        principal: selected,
        registration: finalOrderTaxRead,
        transport: transport(),
      })
      .pipe(Effect.provide(context));
  const evaluate = () =>
    reads
      .runRead({ audience: 'tax', input, principal, registration: taxEvaluationRead, transport: transport() })
      .pipe(Effect.provide(context));
  const write = () =>
    actions
      .runAction({
        audience: 'tax',
        payload,
        principal,
        registration: finalizeOrderTaxAction,
        transport: transport(),
      })
      .pipe(Effect.provide(context));
  const setState = (state: string) =>
    query('UPDATE core.tenant_module_states SET state=$1 WHERE tenant_id=$2 AND module_key=$3', [
      state,
      tenantId,
      MODULE,
    ]);
  const permissionId = toContextPermissionAccessObjectId(tenantId, sellerId, {
    moduleId: MODULE,
    permission: 'tax.governed.read',
  });
  if (permissionId === undefined) {
    return yield* new HistoricalAccessFixtureError({ reason: 'Missing fixture permission identity' });
  }
  const grant = relationship('context_permission', permissionId, 'grantee', 'principal', principalId);
  return {
    changeRelationships,
    evaluate,
    final,
    grant,
    payload,
    principals,
    query,
    readFinal,
    sellerId,
    setState,
    tenantId,
    write,
  };
});

it.live('E29: real Core runtime preserves frozen final reads across inactive suspended and archived states', () =>
  Effect.scoped(
    Effect.gen(function* historicalLifecycle() {
      const test = yield* fixture();
      const active = yield* test.readFinal();
      expect(active.handoff).toEqual(test.final.handoff);
      yield* test.evaluate();
      for (const state of ['inactive', 'suspended', 'archived']) {
        yield* test.setState(state);
        expect(yield* test.readFinal()).toEqual(active);
        expect(Schema.is(ModuleStateDeniedError)(yield* test.evaluate().pipe(Effect.flip))).toBe(true);
        expect(Schema.is(ModuleStateDeniedError)(yield* test.write().pipe(Effect.flip))).toBe(true);
      }
      yield* test.setState('quarantined');
      expect(Schema.is(ModuleStateDeniedError)(yield* test.readFinal().pipe(Effect.flip))).toBe(true);
    }),
  ),
);

it.live('E30: real SpiceDB revocation and PostgreSQL scope prevent unauthorized historical final recovery', () =>
  Effect.scoped(
    Effect.gen(function* historicalAuthorization() {
      const test = yield* fixture();
      const active = yield* test.readFinal();
      yield* test.setState('inactive');
      yield* test.changeRelationships([test.grant], v1.RelationshipUpdate_Operation.DELETE);
      expect(Schema.is(ReadPermissionDenied)(yield* test.readFinal().pipe(Effect.flip))).toBe(true);
      yield* test.changeRelationships([test.grant], v1.RelationshipUpdate_Operation.TOUCH);
      expect(yield* test.readFinal()).toEqual(active);
      for (const principal of test.principals.slice(1)) {
        expect(Schema.is(ReadHandlerNotFound)(yield* test.readFinal(principal).pipe(Effect.flip))).toBe(true);
      }
      const rows = yield* test.query(
        'SELECT count(*)::int AS count FROM tax.tax_order_tax_finalizations WHERE tenant_id=$1 AND legal_entity_id=$2 AND submission_ref=$3',
        [test.tenantId, test.sellerId, test.payload.submissionRef],
      );
      expect(rows.rows).toEqual([{ count: 1 }]);
    }),
  ),
);
