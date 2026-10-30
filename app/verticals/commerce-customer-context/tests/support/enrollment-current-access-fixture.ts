import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationLive,
  ContextAccessLive,
  canonicalizeApplicationComposition,
  extractOutboxWorkerSubscriptions,
  OntosModuleDeploymentContractSchema,
  OutboxRepositoryLive,
  runOutboxCycle,
  matchOutboxMessages,
  validateActiveApplicationCompositionSnapshot,
  PrincipalEligibilityLive,
  defineScopedRoutine,
  loadDatabaseConnectionPair,
  runAction,
} from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import { ChildProcess } from 'effect/process';
import {
  Config,
  Array as EffectArray,
  Context,
  Crypto,
  DateTime,
  Effect,
  Exit,
  Scope,
  Layer,
  Option,
  Order,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import { outboxWorkerLayer } from '../../src/worker-host/layer.ts';
import { outboxWorkers } from '../../src/workers/index.ts';
import { enrollmentApplicationCompositionSnapshot } from './enrollment-application-composition.ts';
import { sql } from 'drizzle-orm';

import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { profileCounterpartyRoleEligibilityResolverFactoryLive } from '../../src/profile-counterparty-role-eligibility.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { claimCounterpartyAccessInvitationAction } from '../../src/actions/claim-counterparty-access-invitation.action.ts';
import { createCounterpartyAccessInvitationAction } from '../../src/actions/create-counterparty-access-invitation.action.ts';
import { CounterpartyRefSchema } from '../../shared/domain/access-contract.ts';
import { CounterpartyInvitationProofDelivery } from '../../shared/domain/invitation-proof-delivery.ts';
import { CommerceEnrollmentAttemptUnavailable } from '../../src/enrollment/attempts/errors.ts';
import type { CommerceEnrollmentOwnerTransactionRun } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import { startPortalEnrollmentAction } from '../../src/actions/start-portal-enrollment.action.ts';
import { bindRetailPortalProfileAction } from '../../src/actions/bind-retail-portal-profile.action.ts';
import {
  readRetailPortalBindingForPrincipal,
  readRetailProfileByParty,
  retailEnrollmentBindingIsCurrentForPrincipal,
} from '../../src/persistence/profile-persistence.ts';
import {
  ProfileRetailPermissionReaderFactory,
  profileRetailPermissionReaderFactoryLive,
} from '../../src/integrations/retail-permission-reader.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import { RetailCustomerProfileRefSchema } from '../../shared/resources/retail-customer-profile.ts';
import { RetailPortalPrincipalRefSchema } from '../../shared/resources/retail-portal-profile-binding.ts';
import {
  RETAIL_PORTAL_SELF_SERVICE_BASELINE,
  SellingLegalEntityRefSchema,
} from '../../shared/domain/profile-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';

const ownerModuleKey = 'commerce.customer-context';

const ensureProfile = defineScopedRoutine({
  name: 'ensure_retail_profile',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({
    outcome: Schema.Literal('PROFILE_CREATED'),
    payload: Schema.Struct({ profileRef: RetailCustomerProfileRefSchema }),
  }),
  routineKey: 'test.enrollment-current-access.ensure-profile',
  schema: 'commerce_customer_context',
});

interface NativeEnrollmentFixtureConfiguration {
  readonly compositionRevision: string;
  readonly connections: Effect.Success<ReturnType<typeof loadDatabaseConnectionPair>>;
  readonly managerProviderSubjectId?: string;
}

/** Native Core identity preparation is a public fixture capability; the binding Action is real. */
export const makeEnrollmentCurrentAccessFixture = Effect.fn('EnrollmentCurrentAccessFixture.make')(
  function* makeEnrollmentCurrentAccessFixtureEffect(configuration?: NativeEnrollmentFixtureConfiguration) {
    const connections = configuration?.connections ?? (yield* loadDatabaseConnectionPair());
    const compositionRevision = configuration?.compositionRevision ?? 'a'.repeat(64);
    const fixtureConfiguration = {
      actionKeys: [
        startPortalEnrollmentAction.descriptor.actionKey,
        bindRetailPortalProfileAction.descriptor.actionKey,
        createCounterpartyAccessInvitationAction.descriptor.actionKey,
        claimCounterpartyAccessInvitationAction.descriptor.actionKey,
      ],
      adminConnectionString: Redacted.make(connections.admin.connectionString),
      allowedAudiences: ['commerce-customer-context'],
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision,
      moduleKeys: [ownerModuleKey],
      runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
    };
    if (configuration?.managerProviderSubjectId !== undefined) {
      Object.assign(fixtureConfiguration, { managerProviderSubjectId: configuration.managerProviderSubjectId });
    }
    const fixture = yield* Effect.acquireRelease(makeLiveOperationFixture(fixtureConfiguration), (resource) =>
      resource.close().pipe(Effect.orDie),
    );
    const retailReader = profileRetailPermissionReaderFactoryLive.pipe(Layer.provide(ContextAccessLive));
    const overlay = commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(Layer.provide(retailReader));
    const core = fixture.layer.pipe(Layer.provide(overlay));
    const ambient = yield* Effect.context<Crypto.Crypto | Scope.Scope>();
    const delivery = yield* CounterpartyInvitationProofDelivery;
    const owners = Layer.mergeAll(
      Layer.succeed(CounterpartyInvitationProofDelivery, delivery),
      ContextAccessLive,
      PrincipalEligibilityLive,
      BusinessPermissionRelationshipMutationLive,
      profileCounterpartyRoleEligibilityResolverFactoryLive,
      profileRetailPermissionReaderFactoryLive,
      profileReactivationEligibilityEvaluatorFactoryLive,
      partyRegistryGuestResolverFactoryLive,
      partyRegistryRetailPartyResolverFactoryLive,
    ).pipe(
      Layer.provide(profileReconfirmationPolicyUnavailableLive),
      Layer.provide(ContextAccessLive),
      Layer.provideMerge(core),
    );
    const ownerContext = yield* Layer.build(owners);
    const workerServices = outboxWorkerLayer.pipe(
      Layer.provide(OutboxRepositoryLive),
      Layer.provide(ContextAccessLive),
      Layer.provide(BusinessPermissionRelationshipMutationLive),
      Layer.provideMerge(Layer.succeedContext(ownerContext)),
    );
    let workerScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(workerScope, exit));
    let workerContext = Context.merge(ambient, yield* Layer.buildWithScope(workerServices, workerScope));
    const context = Context.merge(ambient, ownerContext);
    const prepared = yield* fixture
      .prepareOwner(
        (transaction, scope) =>
          Effect.gen(function* prepareRetailProfile() {
            const [clock] = yield* transaction
              .select({
                at: sql<string>`to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
              })
              .from(sql`(select 1) as operation_clock`);
            if (clock === undefined) {
              return yield* Effect.die('Native operation clock unavailable');
            }
            const partyId = randomUUID();
            const [created] = yield* transaction.invoke(ensureProfile, [
              partyId,
              null,
              'AUTHENTICATED',
              clock.at,
              'AUTHORIZED_ONBOARDING',
              randomUUID(),
              scope.principalId,
            ]);
            if (created === undefined) {
              return yield* Effect.die('Native profile preparation unavailable');
            }
            return { at: clock.at, partyId, profileRef: created.payload.profileRef };
          }),
        'required',
      )
      .pipe(Effect.provideContext(context));
    const mutation = Context.get(context, BusinessPermissionRelationshipMutation);
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        RETAIL_PORTAL_SELF_SERVICE_BASELINE,
        (permission) =>
          mutation.mutate({
            operation: 'revoke',
            permission,
            principal: { principalId: fixture.manager.principalId, tenantId: fixture.tenantId },
            target: {
              kind: 'retail_profile',
              legalEntityId: fixture.legalEntityId,
              profileId: prepared.profileRef.resourceId,
              tenantId: fixture.tenantId,
            },
          }),
        { concurrency: 1 },
      ).pipe(Effect.orDie, Effect.asVoid),
    );
    const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
    const bindingInput = {
      compositionRevision,
      effectiveAt: DateTime.makeUnsafe(prepared.at),
      enrollmentEvidenceRef: randomUUID(),
      principalRef: yield* Schema.decodeEffect(RetailPortalPrincipalRefSchema)({
        moduleId: 'core.identity',
        resourceId: fixture.manager.principalId,
        resourceType: 'core.identity.principal',
        tenantId: fixture.tenantId,
      }),
      profileRef: prepared.profileRef,
      reason: 'Native enrollment Current access',
      requestCorrelation: randomUUID(),
      sellingLegalEntityRef: yield* Schema.decodeEffect(SellingLegalEntityRefSchema)({
        moduleId: 'core.identity',
        resourceId: fixture.legalEntityId,
        resourceType: 'core.identity.legal-entity',
        tenantId: fixture.tenantId,
      }),
    };
    const run: CommerceEnrollmentOwnerTransactionRun = (scope, operation) => {
      if (scope.tenantId !== fixture.tenantId || scope.legalEntityId !== fixture.legalEntityId) {
        return Effect.fail(
          new CommerceEnrollmentAttemptUnavailable({
            code: 'attempt_unavailable',
            reason: 'Native owner phase scope mismatch',
            retryable: true,
          }),
        );
      }
      return fixture
        .prepareOwner((transaction) => operation(transaction), 'required')
        .pipe(
          Effect.provideContext(context),
          Effect.mapError((failure) =>
            Object.defineProperty(
              new CommerceEnrollmentAttemptUnavailable({
                code: 'attempt_unavailable',
                reason: 'Native owner phase unavailable',
                retryable: true,
              }),
              'cause',
              { value: failure },
            ),
          ),
        );
    };
    return {
      bind: (idempotencyKey: string, enrollmentEvidenceRef: string = bindingInput.enrollmentEvidenceRef) =>
        runAction({
          payload: {
            effectiveAt: prepared.at,
            enrollmentEvidenceRef,
            expectedRevision: null,
            expectedState: null,
            principalRef: bindingInput.principalRef,
            profileRef: prepared.profileRef,
            reason: bindingInput.reason,
            sellingLegalEntityRef: bindingInput.sellingLegalEntityRef,
          },
          principal,
          registration: bindRetailPortalProfileAction,
          transport: {
            correlationId: bindingInput.requestCorrelation,
            idempotencyKey,
            targetModuleKey: ownerModuleKey,
          },
        }).pipe(Effect.provideContext(context)),
      bindingInput,
      clockEpoch: () =>
        fixture
          .prepareOwner(
            (transaction) =>
              transaction
                .select({
                  epoch: sql<number>`floor(extract(epoch from clock_timestamp()))::integer`,
                })
                .from(sql`(select 1) as gateway_clock`)
                .pipe(
                  Effect.flatMap(([row]) =>
                    row === undefined ? Effect.die('Native gateway clock unavailable') : Effect.succeed(row.epoch),
                  ),
                ),
            'required',
          )
          .pipe(Effect.provideContext(context)),
      connections,
      context,
      currentAccess: (enrollmentEvidenceRef: string = bindingInput.enrollmentEvidenceRef) =>
        fixture
          .prepareOwner(
            (transaction) =>
              Effect.gen(function* observeCurrentRetailAccess() {
                const scope = {
                  legalEntityId: fixture.legalEntityId,
                  principalId: principal.principalId,
                  tenantId: fixture.tenantId,
                };
                const binding = yield* readRetailPortalBindingForPrincipal(
                  transaction,
                  scope,
                  prepared.profileRef.resourceId,
                );
                if (Option.isNone(binding)) {
                  return false;
                }
                const reader = Context.get(context, ProfileRetailPermissionReaderFactory);
                return yield* retailEnrollmentBindingIsCurrentForPrincipal(
                  transaction,
                  scope,
                  {
                    bindingId: binding.value.bindingRef.resourceId,
                    enrollmentEvidenceRef,
                    profileId: prepared.profileRef.resourceId,
                  },
                  reader.make(scope),
                );
              }),
            'required',
          )
          .pipe(Effect.provideContext(context)),
      cycle: () =>
        Effect.gen(function* runNativeOutboxProgression() {
          const matched = yield* matchOutboxMessages({ compositionRevision });
          // Deliveries use the database clock for available_at; sample that same clock after matching.
          const [row] = yield* fixture
            .prepareOwner(
              (transaction) =>
                transaction
                  .select({
                    at: sql<string>`to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
                  })
                  .from(sql`(select 1) as delivery_clock`),
              'required',
            )
            .pipe(Effect.provideContext(context));
          const clock = yield* Schema.decodeUnknownEffect(Schema.Struct({ at: Schema.DateTimeUtcFromString }))(row);
          const cycle = yield* runOutboxCycle({
            claimOwner: `enrollment-current-${fixture.tenantId}`,
            compositionRevision,
            maxDeliveries: 100,
            now: DateTime.toDateUtc(clock.at),
            registrations: outboxWorkers,
            subscriptions: extractOutboxWorkerSubscriptions(outboxWorkers),
          });
          return { cycle, matched };
        }).pipe(Effect.provideContext(workerContext)),
      fixture,
      ownerFactIdentities: () =>
        fixture
          .prepareOwner(
            (transaction) =>
              Effect.gen(function* readAffectedOwnerFacts() {
                const profile = yield* readRetailProfileByParty(transaction, prepared.partyId);
                const binding = yield* readRetailPortalBindingForPrincipal(
                  transaction,
                  {
                    legalEntityId: fixture.legalEntityId,
                    principalId: principal.principalId,
                    tenantId: fixture.tenantId,
                  },
                  prepared.profileRef.resourceId,
                );
                return {
                  binding: Option.isSome(binding) ? Option.some(binding.value.bindingRef) : Option.none(),
                  profile: Option.isSome(profile) ? Option.some(profile.value.profileRef) : Option.none(),
                };
              }),
            'required',
          )
          .pipe(Effect.provideContext(context)),
      principal,
      readBinding: () =>
        fixture
          .prepareOwner(
            (transaction) =>
              readRetailPortalBindingForPrincipal(
                transaction,
                {
                  legalEntityId: fixture.legalEntityId,
                  principalId: principal.principalId,
                  tenantId: fixture.tenantId,
                },
                prepared.profileRef.resourceId,
              ),
            'required',
          )
          .pipe(Effect.provideContext(context)),
      restartWorker: () =>
        Effect.gen(function* rebuildNativeWorker() {
          yield* Scope.close(workerScope, Exit.void);
          workerScope = yield* Scope.make();
          workerContext = Context.merge(ambient, yield* Layer.buildWithScope(workerServices, workerScope));
        }),
      run,
    };
  },
);

const ensureCounterparty = defineScopedRoutine({
  name: 'ensure_counterparty_profile',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: Schema.Struct({ outcome: Schema.Literal('PROFILE_CREATED') }),
  routineKey: 'test.enrollment-current-access.ensure-counterparty',
  schema: 'commerce_customer_context',
});
const prepareManagementGrant = defineScopedRoutine({
  name: 'begin_access_grant',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'boolean' },
  ],
  resultSchema: Schema.Struct({ grant_id: Schema.String, mutation_id: Schema.String }),
  routineKey: 'test.enrollment-current-access.prepare-management',
  schema: 'commerce_customer_context',
});
const finalizeManagementGrant = defineScopedRoutine({
  name: 'transition_access_grant',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: Schema.Struct({ state: Schema.Literal('ACTIVE') }),
  routineKey: 'test.enrollment-current-access.finalize-management',
  schema: 'commerce_customer_context',
});

/** Prepare continuing inviter authority; the subsequent create and recipient claim Actions are real. */
export const prepareEnrollmentCurrentAccessInvitation = Effect.fn('EnrollmentCurrentAccessFixture.invitation')(
  function* prepareEnrollmentCurrentAccessInvitationEffect(
    native: Effect.Success<ReturnType<typeof makeEnrollmentCurrentAccessFixture>>,
  ) {
    const counterpartyRef = yield* Schema.decodeEffect(CounterpartyRefSchema)({
      moduleId: 'party.registry',
      resourceId: randomUUID(),
      resourceType: 'party.registry.counterparty',
      tenantId: native.fixture.tenantId,
    });
    const managerId = native.fixture.manager.principalId;
    const prepared = yield* native.fixture
      .prepareOwner(
        (transaction) =>
          Effect.gen(function* prepareInviter() {
            yield* transaction.invoke(ensureCounterparty, [
              counterpartyRef.resourceId,
              null,
              randomUUID(),
              '1',
              DateTime.formatIso(native.bindingInput.effectiveAt),
              'AUTHORIZED_ONBOARDING',
              randomUUID(),
              managerId,
            ]);
            const [grant] = yield* transaction.invoke(prepareManagementGrant, [
              counterpartyRef.resourceId,
              managerId,
              'counterparty.access.manage',
              null,
              managerId,
              randomUUID(),
              'Native Current invitation prerequisite',
              true,
            ]);
            if (grant === undefined) {
              return yield* Effect.die('Native inviter grant unavailable');
            }
            return grant;
          }),
        'required',
      )
      .pipe(Effect.provideContext(native.context));
    const mutation = Context.get(native.context, BusinessPermissionRelationshipMutation);
    const management = {
      permission: 'counterparty.access.manage' as const,
      principal: { principalId: managerId, tenantId: native.fixture.tenantId },
      target: {
        counterpartyId: counterpartyRef.resourceId,
        kind: 'counterparty' as const,
        legalEntityId: native.fixture.legalEntityId,
        tenantId: native.fixture.tenantId,
      },
    };
    yield* mutation.mutate({ ...management, operation: 'grant' });
    yield* Effect.addFinalizer(() => mutation.mutate({ ...management, operation: 'revoke' }).pipe(Effect.orDie));
    yield* native.fixture
      .prepareOwner(
        (transaction) =>
          transaction.invoke(finalizeManagementGrant, [prepared.grant_id, prepared.mutation_id, 'grant', 'ACTIVE']),
        'required',
      )
      .pipe(Effect.provideContext(native.context));
    // Independent observer permission prerequisite; profile.read remains claim-derived.
    const [observerGrant] = yield* native.fixture
      .prepareOwner(
        (transaction) =>
          transaction.invoke(prepareManagementGrant, [
            counterpartyRef.resourceId,
            managerId,
            'counterparty.access.read',
            null,
            managerId,
            randomUUID(),
            'Native Current access observer prerequisite',
            true,
          ]),
        'required',
      )
      .pipe(Effect.provideContext(native.context));
    if (observerGrant === undefined) {
      return yield* Effect.die('Native observer grant unavailable');
    }
    const observer = { ...management, permission: 'counterparty.access.read' as const };
    yield* mutation.mutate({ ...observer, operation: 'grant' });
    yield* Effect.addFinalizer(() => mutation.mutate({ ...observer, operation: 'revoke' }).pipe(Effect.orDie));
    yield* native.fixture
      .prepareOwner(
        (transaction) =>
          transaction.invoke(finalizeManagementGrant, [
            observerGrant.grant_id,
            observerGrant.mutation_id,
            'grant',
            'ACTIVE',
          ]),
        'required',
      )
      .pipe(Effect.provideContext(native.context));
    yield* Effect.addFinalizer(() =>
      mutation
        .mutate({
          operation: 'revoke',
          permission: 'counterparty.profile.read',
          principal: { principalId: managerId, tenantId: native.fixture.tenantId },
          target: {
            counterpartyId: counterpartyRef.resourceId,
            kind: 'counterparty',
            legalEntityId: native.fixture.legalEntityId,
            tenantId: native.fixture.tenantId,
          },
        })
        .pipe(Effect.orDie),
    );
    const now = native.bindingInput.effectiveAt;
    const created = yield* runAction({
      payload: {
        counterpartyRef,
        deliveryMethod: 'VERIFIED_CONTACT_POINT',
        deliveryReference: `invitation-${randomUUID()}@example.test`,
        expiresAt: DateTime.formatIso(DateTime.add(now, { days: 1 })),
        intendedPermissions: ['counterparty.profile.read'],
        reason: 'Native enrollment Current access',
        scope: { kind: 'counterparty' },
      },
      principal: native.principal,
      registration: createCounterpartyAccessInvitationAction,
      transport: {
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        targetModuleKey: ownerModuleKey,
      },
    }).pipe(Effect.provideContext(native.context));
    return { counterpartyRef, created, crypto: yield* Crypto.Crypto };
  },
);

const usernameArgument = '--username';
const databaseArgument = '--dbname';
const migrationBoundary = '20261019151239_enrollment_current_claim_read';
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const appRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const digest = (document: string) => createHash('sha256').update(document, 'utf-8').digest('hex');
const MigrationOwnerSchema = Schema.Literals(['commerce_customer_context', 'commerce_portal_auth']);
type MigrationOwner = typeof MigrationOwnerSchema.Type;

/** Full real migration rows are fingerprinted without exposing their values or copying business data. */
const readOwnedMigrationBookkeepingFingerprint = Effect.fn('EnrollmentCurrentAccessFixture.bookkeepingFingerprint')(
  function* readOwnedMigrationBookkeepingFingerprintEffect(
    configuration: NativeEnrollmentFixtureConfiguration['connections']['admin'],
    owner: MigrationOwner,
  ) {
    const child = yield* ChildProcess.make(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGPASSWORD',
        'ontos-db',
        'psql',
        '--host',
        'localhost',
        usernameArgument,
        configuration.user,
        databaseArgument,
        configuration.database,
        '--set',
        'ON_ERROR_STOP=1',
        '--no-align',
        '--tuples-only',
        '--command',
        `select md5(coalesce(jsonb_agg(to_jsonb(journal) order by to_jsonb(journal)::text)::text, '[]')) from drizzle.__drizzle_migrations_${owner} as journal`,
      ],
      {
        env: {
          PATH: yield* Config.String('PATH'),
          PGPASSWORD: decodeURIComponent(new URL(configuration.connectionString).password),
        },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [exit, chunks] = yield* Effect.all(
      [child.exitCode, Stream.runCollect(Stream.decodeText(child.stdout)), Stream.runDrain(child.stderr)],
      { concurrency: 3 },
    );
    const fingerprint = chunks.join('').trim();
    if (exit !== 0 || !/^[a-f0-9]{32}$/u.test(fingerprint)) {
      return yield* Effect.die('Commerce migration bookkeeping fingerprint unavailable');
    }
    return fingerprint;
  },
);

/** Bookkeeping metadata reflects the schema clone; no source business rows are copied. */
const copyOwnedMigrationBookkeeping = Effect.fn('EnrollmentCurrentAccessFixture.copyMigrationBookkeeping')(
  function* copyOwnedMigrationBookkeepingEffect(
    connections: NativeEnrollmentFixtureConfiguration['connections'],
    owner: MigrationOwner,
  ) {
    const source = yield* loadDatabaseConnectionPair();
    const baseline = yield* readOwnedMigrationBookkeepingFingerprint(source.admin, owner);
    const dump = yield* ChildProcess.make(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGPASSWORD',
        'ontos-db',
        'pg_dump',
        '--host',
        'localhost',
        usernameArgument,
        source.admin.user,
        databaseArgument,
        source.admin.database,
        '--data-only',
        '--column-inserts',
        '--table',
        `drizzle.__drizzle_migrations_${owner}`,
      ],
      {
        env: {
          PATH: yield* Config.String('PATH'),
          PGPASSWORD: decodeURIComponent(new URL(source.admin.connectionString).password),
        },
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const restore = yield* ChildProcess.make(
      'docker',
      [
        'exec',
        '-i',
        '-e',
        'PGPASSWORD',
        'ontos-db',
        'psql',
        '--host',
        'localhost',
        usernameArgument,
        connections.admin.user,
        databaseArgument,
        connections.admin.database,
        '--set',
        'ON_ERROR_STOP=1',
        '--quiet',
      ],
      {
        env: {
          PATH: yield* Config.String('PATH'),
          PGPASSWORD: decodeURIComponent(new URL(connections.admin.connectionString).password),
        },
        stderr: 'pipe',
        stdin: dump.stdout,
        stdout: 'pipe',
      },
    );
    const [dumpExit, restoreExit] = yield* Effect.all(
      [
        dump.exitCode,
        restore.exitCode,
        Stream.runDrain(dump.stderr),
        Stream.runDrain(restore.stderr),
        Stream.runDrain(restore.stdout),
      ],
      { concurrency: 5 },
    );
    if (dumpExit !== 0 || restoreExit !== 0) {
      return yield* Effect.die('Owned Commerce migration bookkeeping copy failed');
    }
    const sourceAfter = yield* readOwnedMigrationBookkeepingFingerprint(source.admin, owner);
    const owned = yield* readOwnedMigrationBookkeepingFingerprint(connections.admin, owner);
    if (sourceAfter !== baseline || owned !== baseline) {
      return yield* Effect.die('Copied Commerce migration bookkeeping does not match the source baseline');
    }
    return yield* Effect.void;
  },
);

/** Apply only the finalized owner journal ending at #1232; a later draft migration is excluded. */
const migrateOwnedCurrentAccessBoundary = Effect.fn('EnrollmentCurrentAccessFixture.migrateBoundary')(
  function* migrateOwnedCurrentAccessBoundaryEffect(connections: NativeEnrollmentFixtureConfiguration['connections']) {
    const work = `${packageRoot}node_modules/.cache/ontos-1232/${randomUUID()}`;
    const journal = `${work}/drizzle`;
    yield* Effect.promise(async () => await mkdir(journal, { recursive: true }));
    yield* Effect.addFinalizer(() => Effect.promise(async () => await rm(work, { force: true, recursive: true })));
    const folders = EffectArray.sort(
      (yield* Effect.promise(async () => await readdir(`${packageRoot}drizzle`))).filter(
        (name) => /^\d{14}_/u.test(name) && name <= migrationBoundary,
      ),
      Order.String,
    );
    if (folders.at(-1) !== migrationBoundary) {
      return yield* Effect.die('The finalized enrollment migration boundary is absent');
    }
    yield* Effect.forEach(
      folders,
      (name) =>
        Effect.promise(
          async () => await cp(`${packageRoot}drizzle/${name}`, `${journal}/${name}`, { recursive: true }),
        ),
      { concurrency: 1 },
    );
    const configPath = `${work}/drizzle.config.ts`;
    const source = `import { defineConfig } from 'drizzle-kit';\nconst url = process.env.ONTOS_TEST_MIGRATION_DATABASE_URL;\nif (!url) throw new Error('Owned migration connection missing');\nexport default defineConfig({ dialect: 'postgresql', out: ${JSON.stringify(journal)}, dbCredentials: { url }, migrations: { schema: 'drizzle', table: '__drizzle_migrations_commerce_customer_context' } });\n`;
    yield* Effect.promise(async () => await writeFile(configPath, source));
    const child = yield* ChildProcess.make(
      'mise',
      [
        'exec',
        '--',
        'pnpm',
        '--filter',
        '@app/commerce-customer-context',
        'exec',
        'drizzle-kit',
        'migrate',
        '--config',
        configPath,
      ],
      {
        cwd: appRoot,
        env: { ONTOS_TEST_MIGRATION_DATABASE_URL: connections.admin.connectionString },
        extendEnv: true,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    );
    const [exit] = yield* Effect.all([child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
      concurrency: 3,
    });
    if (exit !== 0) {
      return yield* Effect.die('Owned enrollment migration boundary failed');
    }
    return yield* Effect.void;
  },
);

/** The exact generated worker subscription catalog is published only in this owned database. */
export const makeOwnedEnrollmentCurrentAccessDatabase = Effect.fn('EnrollmentCurrentAccessFixture.ownedDatabase')(
  function* makeOwnedEnrollmentCurrentAccessDatabaseEffect(baseSnapshot?: ActiveApplicationCompositionSnapshot) {
    const base = baseSnapshot ?? (yield* enrollmentApplicationCompositionSnapshot);
    const deployment = base.composition.modules.find((module) => module.moduleId === ownerModuleKey)?.deployment;
    if (deployment === undefined) {
      return yield* Effect.die('The enrollment owner deployment is absent');
    }
    const contractSchema = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
    const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(
      makeModuleContractFixture({
        appId: deployment.appId,
        buildMarker: deployment.buildMarker,
        moduleId: ownerModuleKey,
        outboxSubscriptions: extractOutboxWorkerSubscriptions(outboxWorkers),
      }),
    );
    const contractDocument = yield* Schema.encodeEffect(contractSchema)(contract);
    const hash = digest(contractDocument);
    const composition = {
      ...base.composition,
      modules: base.composition.modules.map((module) => ({
        ...module,
        contract: { ...module.contract, sha256: hash },
        contractDocument,
        publicContract: { ...module.publicContract, sha256: hash },
      })),
      revision: '0'.repeat(64),
    };
    const snapshot = yield* validateActiveApplicationCompositionSnapshot({
      ...base,
      composition: { ...composition, revision: digest(canonicalizeApplicationComposition(composition)) },
    });
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: snapshot,
      mode: 'schema-only',
      purpose: 'stabilization-1232-current-access',
    });
    for (const owner of MigrationOwnerSchema.literals) {
      yield* copyOwnedMigrationBookkeeping(isolated.connections, owner);
    }
    yield* migrateOwnedCurrentAccessBoundary(isolated.connections);
    return { connections: isolated.connections, snapshot };
  },
);

export const makeOwnedEnrollmentCurrentAccessFixture = Effect.fn('EnrollmentCurrentAccessFixture.owned')(
  function* makeOwnedEnrollmentCurrentAccessFixtureEffect(baseSnapshot?: ActiveApplicationCompositionSnapshot) {
    const owned = yield* makeOwnedEnrollmentCurrentAccessDatabase(baseSnapshot);
    const native = yield* makeEnrollmentCurrentAccessFixture({
      compositionRevision: owned.snapshot.composition.revision,
      connections: owned.connections,
    });
    return { ...native, snapshot: owned.snapshot };
  },
);
