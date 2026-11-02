// @rstest-environment happy-dom
// @rstest-environment-options {"url":"https://party.ontos.test"}
import {
  makePartyReconciliationGateway,
  preparePartyReconciliationNative,
} from '../support/party-reconciliation-native.fixture.ts';
import { DatabaseConfig, makeContextPermissionRelationshipMutationLive } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT } from '@app/party-registry-identity-contracts';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { eq, sql } from 'drizzle-orm';
import {
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Effect,
  Deferred,
  Fiber,
  Exit,
  Layer,
  Match,
  Option,
  Predicate,
  Redacted,
  Schema,
} from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { assert, expect, it } from 'effect-rstest';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { partyRegistryCommandsLive, partyRegistryCommandRecoveryLive } from '../../api/party-command-server.ts';
import { partyCorrectionReadApiLive } from '../../api/party-correction-read-server.ts';
import { partyOfficialIdentifierHistoryReadApiLive } from '../../api/party-official-identifier-history-read-server.ts';
import { partyRegistryApi } from '../../shared/api.ts';
import { IdentityCorrectionCommandSchema } from '../../shared/domain/correction-contracts.ts';
import { partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { addPartyOfficialIdentifierAction } from '../../src/actions/add-party-official-identifier.action.ts';
import { correctPartyFactAction } from '../../src/actions/correct-party-fact.action.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { endPartyOfficialIdentifierAction } from '../../src/actions/end-party-official-identifier.action.ts';
import { resolveDuplicateCandidateCreateAction } from '../../src/actions/resolve-duplicate-candidate-create.action.ts';
import {
  addPartyOfficialIdentifierWithAuthorization,
  correctPartyFactWithAuthorization,
  createPartyWithAuthorization,
  endPartyOfficialIdentifierWithAuthorization,
  resolveDuplicateCandidateCreateWithAuthorization,
  resolvePartyCommandCommitWithAuthorization,
} from '../../src/api/party-command-client.ts';
import { executePartyCorrectionWithAuthorization } from '../../src/api/party-correction-client.ts';
import { executePartyOfficialIdentifierHistoryWithAuthorization } from '../../src/api/party-official-identifier-history-client.ts';
import { lockTenantIdentityWrites } from '../../src/services/party-identifier-claim.service.ts';
import { makePartyDatabase } from '../../src/db/client.ts';
import { partyCorrections, partyIdentifierClaims, partyOfficialIdentifiers } from '../../src/db/schema.ts';

import {
  PartyCommandCommitIndeterminateProblemSchema,
  ResolvePartyCommandCommitPayloadSchema,
} from '../../shared/command-api.ts';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const emptyContext = Context.makeUnsafe<unknown>(new Map());
const makeFixture = Effect.gen(function* makeFixture() {
  const composition = yield* makeApplicationCompositionSnapshotFixture(
    [ultramodernApiMarker.appId],
    ultramodernApiMarker.buildMarker,
  );
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'schema-only',
    purpose: 'stabilization-1240-identifier-correction-reuse',
    compositionSnapshot: composition,
  });
  const native = yield* preparePartyReconciliationNative(isolated.connections);
  const connections = { ...isolated.connections, runtime: native.partyConfiguration };
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionKeys: [
        addPartyOfficialIdentifierAction,
        correctPartyFactAction,
        createPartyAction,
        endPartyOfficialIdentifierAction,
        resolveDuplicateCandidateCreateAction,
      ].map((action) => action.descriptor.actionKey),
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: composition.composition.revision,
      adminConnectionString: Redacted.make(connections.admin.connectionString),
      databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
      runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
    }),
    (value) => value.close().pipe(Effect.orDie),
  );
  const adminLayer = PgClient.layer({ url: Redacted.make(connections.admin.connectionString) }).pipe(
    Layer.provideMerge(Reactivity.layer),
  );
  const adminContext = yield* Layer.build(adminLayer);
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
  const { executor: admin } = yield* makePartyDatabase(connections.admin);
  const principal = fixture.manager;
  const contextPermissions = yield* makeContextPermissionRelationshipMutationLive();
  const moduleTarget = { moduleId: 'party.registry', permission: 'module.access' };
  const moduleAccess = (actor: typeof principal, operation: 'grant' | 'revoke') =>
    contextPermissions.mutate({ operation, principal: actor, target: moduleTarget, tenantId: fixture.tenantId });
  yield* contextPermissions.mutate({ operation: 'grant', principal, target: moduleTarget, tenantId: fixture.tenantId });
  yield* Effect.addFinalizer(() =>
    contextPermissions
      .mutate({ operation: 'revoke', principal, target: moduleTarget, tenantId: fixture.tenantId })
      .pipe(Effect.orDie),
  );
  const gateway = yield* makePartyReconciliationGateway(native, composition);
  const { issuer, jwks } = gateway;
  const authorization = (actor = principal) => gateway.authorization(actor);
  const redemption = GatewayAssertionRedemptionLive.pipe(
    Layer.provide(GatewayAssertionRedemptionDatabaseLive),
    Layer.provide(Layer.succeed(DatabaseConfig, connections.runtime)),
  );
  const api = HttpApi.make('PartyRegistryApi')
    .add(partyRegistryApi.groups.partyCommands)
    .add(partyRegistryApi.groups.partyOfficialIdentifierHistory)
    .add(partyRegistryApi.groups.partyCorrection)
    .add(partyRegistryApi.groups.partyCommandRecovery);
  const handlers = Layer.mergeAll(
    partyRegistryCommandsLive,
    partyRegistryCommandRecoveryLive,
    partyOfficialIdentifierHistoryReadApiLive,
    partyCorrectionReadApiLive,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ActionPrincipalVerifierLive,
        makeActiveApplicationCompositionLayer(Effect.succeed(composition)),
      ).pipe(Layer.provide(ActiveApplicationCompositionSourceLive), Layer.provide(FetchHttpClient.layer)),
    ),
    Layer.provide(redemption),
    Layer.provide(fixture.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ ONTOS_GATEWAY_ISSUER: issuer, ONTOS_GATEWAY_PUBLIC_JWKS: jwks }),
      ),
    ),
  );
  const app = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(api).pipe(
          Layer.provide(handlers),
          Layer.provideMerge(fixture.layer),
          Layer.provide(HttpServer.layerServices),
          Layer.provide(NodeCrypto.layer),
        ),
        { disableLogger: true },
      ),
    ),
    (value) => Effect.promise(value.dispose.bind(value)).pipe(Effect.orDie),
  );
  const inMemoryFetch: typeof fetch = (input, init) => app.handler(new Request(input, init), emptyContext);
  const runHttp = <Value, Failure>(operation: Effect.Effect<Value, Failure>) =>
    operation.pipe(Effect.provideService(FetchHttpClient.Fetch, inMemoryFetch));
  const baseUrl = 'https://party.ontos.test';
  const options = Effect.gen(function* options() {
    return {
      baseUrl,
      compositionRevision: composition.composition.revision,
      correlationId: yield* nextId,
      idempotencyKey: yield* nextId,
    };
  });
  const create = Effect.fn('OriginalIdentifierInputTest.create')(function* create() {
    const created = yield* runHttp(
      createPartyWithAuthorization(
        {
          candidate: {
            partyType: 'ORGANIZATION',
            officialIdentifiers: [],
            evidenceRefs: ['original-input/review'],
            subjectEvidence: [
              {
                basis: 'REVIEWED_DOCUMENT',
                evidenceRef: 'original-input/review',
                kind: 'ACTOR_ATTESTATION',
                observedSubject: 'ORGANIZATION',
                statement: 'Reviewed a distinct external organization',
                subjectKey: partySubjectKeyFromString(yield* nextId),
              },
            ],
            provenance: { method: 'DOCUMENT', source: 'original-input-test' },
            validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
          },
        },
        yield* authorization(),
        yield* options,
      ),
    );
    assert.isOk(created.outcome === 'AMBIGUOUS');
    const reviewed = yield* runHttp(
      resolveDuplicateCandidateCreateWithAuthorization(
        {
          caseRef: created.caseRef,
          expectedRevision: 1,
          reason: 'Reviewed distinct concrete organization without strong identifiers',
        },
        yield* authorization(),
        yield* options,
      ),
    );
    assert.isOk(reviewed.partyRef);
    return reviewed.partyRef;
  });
  const add = Effect.fn('OriginalIdentifierInputTest.add')(function* add(
    partyRef: PartyRef,
    value: string,
    commandOptions: typeof options extends Effect.Effect<infer Value, infer _Failure, infer _Requirements>
      ? Value
      : never,
    identifierType: 'ICO' | 'CZ_DIC' = 'ICO',
    actor = principal,
    verification: 'UNVERIFIED' | 'VERIFIED' = 'UNVERIFIED',
  ) {
    return yield* runHttp(
      addPartyOfficialIdentifierWithAuthorization(
        {
          identifier: { identifierType, value, verification },
          partyRef,
          provenanceMethod: 'MANUAL',
          provenanceSource: 'original-input-test',
          validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
        },
        yield* authorization(actor),
        commandOptions,
      ),
    );
  });
  const history = Effect.fn('OriginalIdentifierInputTest.history')(function* history(
    partyRef: PartyRef,
    actor = principal,
  ) {
    return yield* runHttp(
      executePartyOfficialIdentifierHistoryWithAuthorization({ partyRef }, yield* authorization(actor), yield* nextId, {
        baseUrl,
        compositionRevision: composition.composition.revision,
      }),
    );
  });
  const rows = () =>
    admin.select().from(partyOfficialIdentifiers).where(eq(partyOfficialIdentifiers.tenantId, fixture.tenantId));

  const correct = Effect.fn('IdentifierCorrectionReuseTest.correct')(function* correct(
    partyRef: PartyRef,
    targetAssertionId: string,
    replacementValue: string | undefined,
    commandOptions: Effect.Success<typeof options>,
    actor = principal,
  ) {
    const command = {
      partyId: partyRef.resourceId,
      targetAssertionId,
      factKind: 'OFFICIAL_IDENTIFIER',
      reasonCode: 'WRONG_IDENTITY_VALUE',
      reasonDetail: 'Reviewed evidence establishes the previous accepted value was incorrect',
      evidenceSource: 'DOCUMENT',
      evidenceRefs: ['identifier-correction/review'],
      policyVersion: 'party-correction.v1',
      provenance: { method: 'DOCUMENT', source: 'identifier-correction-test' },
    };
    const payload = replacementValue === undefined ? command : { ...command, replacementValue };
    return yield* runHttp(
      correctPartyFactWithAuthorization(
        yield* Schema.decodeUnknownEffect(IdentityCorrectionCommandSchema)(payload),
        yield* authorization(actor),
        commandOptions,
      ),
    );
  });
  const correctionDetail = Effect.fn('IdentifierCorrectionReuseTest.correctionDetail')(function* correctionDetail(
    correctionRef: Effect.Success<ReturnType<typeof correct>>['correctionRef'],
    actor = principal,
  ) {
    return yield* runHttp(
      executePartyCorrectionWithAuthorization({ correctionRef }, yield* authorization(actor), yield* nextId, {
        baseUrl,
        compositionRevision: composition.composition.revision,
      }),
    );
  });
  const corrections = () =>
    admin.select().from(partyCorrections).where(eq(partyCorrections.tenantId, fixture.tenantId));
  const claims = () =>
    admin.select().from(partyIdentifierClaims).where(eq(partyIdentifierClaims.tenantId, fixture.tenantId));
  const resolve = Effect.fn('IdentifierCorrectionReuseTest.resolve')(function* resolve(invocationId: string) {
    return yield* runHttp(
      resolvePartyCommandCommitWithAuthorization(
        yield* Schema.decodeUnknownEffect(ResolvePartyCommandCommitPayloadSchema)({ invocationId }),
        yield* authorization(),
        yield* options,
      ),
    );
  });
  const end = Effect.fn('IdentifierCorrectionReuseTest.end')(function* end(
    officialIdentifierRef: Effect.Success<ReturnType<typeof add>>['officialIdentifierRef'],
  ) {
    return yield* runHttp(
      endPartyOfficialIdentifierWithAuthorization(
        {
          officialIdentifierRef,
          reason: 'The identifier ceased to be valid',
          validTo: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
        },
        yield* authorization(),
        yield* options,
      ),
    );
  });
  return {
    admin,
    composition,
    moduleAccess,
    end,
    add,
    authorization,
    claims,
    connections,
    coreEvidenceExecutor,
    correct,
    correctionDetail,
    corrections,
    create,
    fixture,
    history,
    isolated,
    options,
    principal,
    resolve,
    rows,
    runHttp,
  };
});

it.layer(
  NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeCrypto.layer), Layer.provideMerge(NodeServices.layer)),
  { excludeTestServices: true },
)((suite) => {
  suite.effect(
    'native public correction preserves new replacement, pure retraction, rollback and lost acknowledgement truth',
    () =>
      Effect.gen(function* correctionSettlement() {
        const h = yield* makeFixture;
        const partyRef = yield* h.create();
        const a = yield* h.add(partyRef, '27074358', yield* h.options);
        const created = yield* h.correct(partyRef, a.officialIdentifierRef.resourceId, '1000004', yield* h.options);
        const replacementId = Option.getOrThrow(created.replacementAssertionId);
        const newRow = (yield* h.rows()).find((row) => row.officialIdentifierId === replacementId);
        assert.isOk(newRow);
        expect(newRow.normalizedValue).toBe('01000004');
        expect(newRow.supersedesOfficialIdentifierId).toBe(a.officialIdentifierRef.resourceId);
        expect(newRow.verificationState).toBe('UNVERIFIED');
        const retracted = yield* h.correct(partyRef, replacementId, undefined, yield* h.options);
        expect(Option.isNone(retracted.replacementAssertionId)).toBe(true);
        expect((yield* h.rows()).find((row) => row.officialIdentifierId === replacementId)?.state).toBe('RETRACTED');
        expect((yield* h.history(partyRef)).items).toHaveLength(2);
        const endedParty = yield* h.create();
        const endedTarget = yield* h.add(endedParty, '27074358', yield* h.options);
        const endedReplacement = yield* h.add(endedParty, '26168685', yield* h.options);
        yield* h.end(endedReplacement.officialIdentifierRef);
        const beforeEndedTarget = yield* h.rows();
        const beforeEndedCorrections = yield* h.corrections();
        const endedTargetFailure = yield* Effect.flip(
          h.correct(endedParty, endedReplacement.officialIdentifierRef.resourceId, '1000004', yield* h.options),
        );
        expect(Predicate.isTagged(endedTargetFailure, 'PartyCommandConflictProblem')).toBe(true);
        expect(yield* h.rows()).toEqual(beforeEndedTarget);
        expect(yield* h.corrections()).toEqual(beforeEndedCorrections);
        const afterEnd = yield* h.correct(
          endedParty,
          endedTarget.officialIdentifierRef.resourceId,
          '26168685',
          yield* h.options,
        );
        expect(Option.getOrThrow(afterEnd.replacementAssertionId)).not.toBe(
          endedReplacement.officialIdentifierRef.resourceId,
        );
        expect((yield* h.history(endedParty)).items).toHaveLength(3);
        expect((yield* h.history(endedParty)).items.filter((row) => row.state === 'ACTIVE')).toHaveLength(1);
        const typedParty = yield* h.create();
        const typedTarget = yield* h.add(typedParty, '27074358', yield* h.options);
        const taxIdentifier = yield* h.add(typedParty, 'cz26168685', yield* h.options, 'CZ_DIC');
        const typeCorrection = yield* h.correct(
          typedParty,
          typedTarget.officialIdentifierRef.resourceId,
          '26168685',
          yield* h.options,
        );
        expect(Option.getOrThrow(typeCorrection.replacementAssertionId)).not.toBe(
          taxIdentifier.officialIdentifierRef.resourceId,
        );
        expect(
          (yield* h.history(typedParty)).items
            .filter((row) => row.state === 'ACTIVE')
            .map((row) => row.identifierType)
            .toSorted(),
        ).toEqual(['CZ_DIC', 'ICO']);
        const secondParty = yield* h.create();
        const x = yield* h.add(secondParty, '27074358', yield* h.options);
        const y = yield* h.add(secondParty, '26168685', yield* h.options);
        const before = yield* h.rows();
        const beforeCorrections = yield* h.corrections();
        const beforeEvidence = yield* h.fixture.evidence(h.coreEvidenceExecutor);
        h.fixture.faultNextTransaction('rollback');
        const rollbackOptions = yield* h.options;
        expect(
          Exit.isFailure(
            yield* Effect.exit(h.correct(secondParty, x.officialIdentifierRef.resourceId, '26168685', rollbackOptions)),
          ),
        ).toBe(true);
        expect(yield* h.rows()).toEqual(before);
        expect(yield* h.corrections()).toEqual(beforeCorrections);
        const afterRollback = yield* h.fixture.evidence(h.coreEvidenceExecutor);
        expect(afterRollback.events).toHaveLength(beforeEvidence.events.length);
        expect(afterRollback.outbox).toHaveLength(beforeEvidence.outbox.length);
        expect(afterRollback.audits).toHaveLength(beforeEvidence.audits.length);
        const recovered = yield* h.correct(secondParty, x.officialIdentifierRef.resourceId, '26168685', {
          ...rollbackOptions,
          correlationId: yield* nextId,
        });
        expect(Option.getOrThrow(recovered.replacementAssertionId)).toBe(y.officialIdentifierRef.resourceId);
        const thirdParty = yield* h.create();
        const old = yield* h.add(thirdParty, '27074358', yield* h.options);
        const existing = yield* h.add(thirdParty, '1000004', yield* h.options);
        const preserved = (yield* h.rows()).find(
          (row) => row.officialIdentifierId === existing.officialIdentifierRef.resourceId,
        );
        h.fixture.faultNextTransaction('lost-ack');
        const unknownOptions = yield* h.options;
        const unknown = yield* Effect.flip(
          h.correct(thirdParty, old.officialIdentifierRef.resourceId, '01000004', unknownOptions),
        );
        assert.isOk(Schema.is(PartyCommandCommitIndeterminateProblemSchema)(unknown));
        expect((yield* h.resolve(unknown.invocationId)).state).toBe('COMMITTED');
        const durable = yield* h.rows();
        expect(durable.find((row) => row.officialIdentifierId === existing.officialIdentifierRef.resourceId)).toEqual(
          preserved,
        );
        const replay = yield* Effect.flip(
          h.correct(thirdParty, old.officialIdentifierRef.resourceId, '01000004', {
            ...unknownOptions,
            correlationId: yield* nextId,
          }),
        );
        expect(Predicate.isTagged(replay, 'PartyCommandAlreadyCommittedProblem')).toBe(true);
        expect(yield* h.rows()).toEqual(durable);
        const history = yield* h.history(thirdParty);
        expect(history.items.filter((row) => row.state === 'ACTIVE').map((row) => row.officialIdentifierRef)).toEqual([
          existing.officialIdentifierRef,
        ]);
      }),
  );
  suite.effect(
    'public Add and Correction serialize in both native lock orders without duplicate canonical assertions',
    () =>
      Effect.gen(function* correctionConcurrency() {
        const h = yield* makeFixture;
        for (const first of ['ADD', 'CORRECTION'] as const) {
          const partyRef = yield* h.create();
          const a = yield* h.add(partyRef, '27074358', yield* h.options);
          const holding = yield* Deferred.make<number>();
          const release = yield* Deferred.make<boolean>();
          const barrier = yield* h.admin
            .transaction((transaction) =>
              Effect.gen(function* holdIdentity() {
                yield* lockTenantIdentityWrites(transaction, h.fixture.tenantId);
                const [identity] = yield* transaction.execute<{ readonly pid: number }>(
                  sql`select pg_backend_pid() as pid`,
                  'objects',
                );
                assert.isOk(identity);
                yield* Deferred.succeed(holding, identity.pid);
                yield* Deferred.await(release);
              }),
            )
            .pipe(Effect.forkChild);
          yield* Effect.addFinalizer(() => Deferred.succeed(release, true));
          const holder = yield* Deferred.await(holding);
          const addOptions = yield* h.options;
          const correctOptions = yield* h.options;
          const add = h.add(partyRef, '26168685', addOptions);
          const correct = h.correct(partyRef, a.officialIdentifierRef.resourceId, '26168685', correctOptions);
          const invoke = (operation: 'ADD' | 'CORRECTION') =>
            Effect.gen(function* invokeOrderedRequest() {
              if (operation === 'ADD') {
                return { _tag: 'ADD' as const, value: yield* add };
              }
              return { _tag: 'CORRECTION' as const, value: yield* correct };
            });
          const waitFor = Effect.fn('IdentifierCorrectionReuseTest.waitForNativeWaiters')(function* waitFor(
            firstBackend?: number,
          ) {
            for (let attempt = 0; attempt < 1000; attempt += 1) {
              // A later Core write may wait on the first writer's tenant lock. Follow
              // actual blocker descendants in this owned database, never query text.
              const waiters = yield* h.admin.execute<{ readonly pid: number }>(
                sql`with recursive waiting(pid) as (
                  select pid from pg_stat_activity
                  where datname = current_database() and ${holder}::integer = any(pg_blocking_pids(pid))
                  union
                  select activity.pid from pg_stat_activity activity
                  inner join waiting blocker on blocker.pid = any(pg_blocking_pids(activity.pid))
                  where activity.datname = current_database()
                ) select pid from waiting order by pid limit 3`,
                'objects',
              );
              if (firstBackend === undefined && waiters.length === 1) {
                return waiters[0]?.pid;
              }
              if (
                firstBackend !== undefined &&
                waiters.some((row) => row.pid === firstBackend) &&
                waiters.some((row) => row.pid !== firstBackend)
              ) {
                return firstBackend;
              }
              yield* Effect.yieldNow;
            }
            return yield* Effect.die(
              'The concurrent governed requests did not form the expected native blocking chain',
            );
          });
          const settled = { first: false, second: false };
          const firstRequest = yield* invoke(first).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                settled.first = true;
              }),
            ),
            Effect.forkChild,
          );
          const firstBackend = yield* waitFor();
          assert.isOk(firstBackend !== undefined);
          const secondRequest = yield* invoke(first === 'ADD' ? 'CORRECTION' : 'ADD').pipe(
            Effect.ensuring(
              Effect.sync(() => {
                settled.second = true;
              }),
            ),
            Effect.forkChild,
          );
          yield* waitFor(firstBackend);
          expect(settled).toEqual({ first: false, second: false });
          const earliestCorrection = yield* DateTime.nowAsDate;
          yield* Deferred.succeed(release, true);
          yield* Fiber.join(barrier);
          const firstResult = yield* Fiber.join(firstRequest);
          const secondResult = yield* Fiber.join(secondRequest);
          const latestCorrection = yield* DateTime.nowAsDate;
          const results = [firstResult, secondResult];
          const additions = results.flatMap((result) =>
            Match.value(result).pipe(
              Match.tag('ADD', ({ value }) => [value]),
              Match.tag('CORRECTION', () => []),
              Match.exhaustive,
            ),
          );
          const corrections = results.flatMap((result) =>
            Match.value(result).pipe(
              Match.tag('ADD', () => []),
              Match.tag('CORRECTION', ({ value }) => [value]),
              Match.exhaustive,
            ),
          );
          const [addResult] = additions;
          const [correctionResult] = corrections;
          assert.isOk(addResult);
          assert.isOk(correctionResult);
          const resultingId = Option.getOrThrow(correctionResult.replacementAssertionId);
          expect(addResult.officialIdentifierRef.resourceId).toBe(resultingId);
          const rows = (yield* h.rows()).filter((row) => row.partyId === partyRef.resourceId);
          const original = rows.find((row) => row.officialIdentifierId === a.officialIdentifierRef.resourceId);
          const replacement = rows.find((row) => row.officialIdentifierId === resultingId);
          assert.isOk(original?.validTo);
          assert.isOk(replacement);
          expect(original.validTo >= earliestCorrection && original.validTo <= latestCorrection).toBe(true);
          if (first === 'ADD') {
            expect(replacement.validFrom).toEqual(DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-01T00:00:00.000Z')));
            expect(replacement.provenanceMethod).toBe('MANUAL');
            expect(replacement.provenanceSource).toBe('original-input-test');
          } else {
            expect(replacement.validFrom).toEqual(original.validTo);
            expect(replacement.provenanceMethod).toBe('DOCUMENT');
            expect(replacement.provenanceSource).toBe('identifier-correction-test');
          }
          const current = (yield* h.history(partyRef)).items.filter((row) => row.state === 'ACTIVE');
          expect(current).toHaveLength(1);
          expect(current[0]?.normalizedValue).toBe('26168685');
          expect((yield* h.rows()).filter((row) => row.partyId === partyRef.resourceId)).toHaveLength(2);
        }
        const contestedParty = yield* h.create();
        const target = yield* h.add(contestedParty, '27074358', yield* h.options);
        yield* h.add(contestedParty, '26168685', yield* h.options);
        yield* h.add(contestedParty, '1000004', yield* h.options);
        const firstIntent = yield* h.options;
        const secondIntent = yield* h.options;
        const outcomes = yield* Effect.all(
          [
            h
              .correct(contestedParty, target.officialIdentifierRef.resourceId, '26168685', firstIntent)
              .pipe(Effect.exit),
            h
              .correct(contestedParty, target.officialIdentifierRef.resourceId, '01000004', secondIntent)
              .pipe(Effect.exit),
          ],
          { concurrency: 2 },
        );
        expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
        const rejected = outcomes.find(Exit.isFailure);
        assert.isOk(rejected);
        expect(
          Predicate.isTagged(Option.getOrThrow(Exit.findErrorOption(rejected)), 'PartyCommandConflictProblem'),
        ).toBe(true);
        expect((yield* h.corrections()).filter((row) => row.partyId === contestedParty.resourceId)).toHaveLength(1);
        expect((yield* h.rows()).filter((row) => row.partyId === contestedParty.resourceId)).toHaveLength(3);
      }),
    120_000,
  );

  suite.effect(
    'public Add and Correction converge to retained B with truthful native history, retry and authority',
    () =>
      Effect.gen(function* currentIdentifierReuseNative() {
        const h = yield* makeFixture;
        const partyRef = yield* h.create();
        const a = yield* h.add(partyRef, '27074358', yield* h.options);
        const b = yield* h.add(partyRef, '26168685', yield* h.options, 'ICO', h.principal, 'VERIFIED');
        const before = yield* h.rows();
        const beforeB = before.find((row) => row.officialIdentifierId === b.officialIdentifierRef.resourceId);
        assert.isOk(beforeB);
        const priorClaims = yield* h.claims();
        const repeated = yield* h.add(partyRef, '26168685', yield* h.options);
        expect(repeated.officialIdentifierRef).toEqual(b.officialIdentifierRef);
        expect(yield* h.rows()).toEqual(before);
        const commandOptions = yield* h.options;
        const corrected = yield* h.correct(partyRef, a.officialIdentifierRef.resourceId, '26168685', commandOptions);
        expect(Option.getOrThrow(corrected.replacementAssertionId)).toBe(b.officialIdentifierRef.resourceId);
        expect(corrected.retractedAssertionId).toBe(a.officialIdentifierRef.resourceId);
        const after = yield* h.rows();
        expect(after).toHaveLength(2);
        expect(after.find((row) => row.officialIdentifierId === b.officialIdentifierRef.resourceId)).toEqual(beforeB);
        expect(
          after.filter((row) => row.isCurrent && row.state === 'ACTIVE').map((row) => row.officialIdentifierId),
        ).toEqual([b.officialIdentifierRef.resourceId]);
        expect(after.find((row) => row.officialIdentifierId === a.officialIdentifierRef.resourceId)?.state).toBe(
          'SUPERSEDED',
        );
        expect(yield* h.claims()).toEqual(priorClaims);
        const history = yield* h.history(partyRef);
        expect(history.items).toHaveLength(2);
        expect(history.items.filter((row) => row.state === 'ACTIVE').map((row) => row.officialIdentifierRef)).toEqual([
          b.officialIdentifierRef,
        ]);
        const detail = yield* h.correctionDetail(corrected.correctionRef);
        expect(detail.targetAssertionId).toBe(a.officialIdentifierRef.resourceId);
        expect(Option.getOrThrow(detail.resultingAssertion).assertionId).toBe(b.officialIdentifierRef.resourceId);
        expect(detail.reasonCode).toBe('WRONG_IDENTITY_VALUE');
        expect(detail.evidenceRefs).toEqual(['identifier-correction/review']);
        expect(detail.actingPrincipalId).toBe(h.principal.principalId);
        expect(yield* h.corrections()).toHaveLength(1);
        const evidence = yield* h.fixture.evidence(h.coreEvidenceExecutor);
        const replay = yield* Effect.flip(
          h.correct(partyRef, a.officialIdentifierRef.resourceId, '26168685', {
            ...commandOptions,
            correlationId: yield* nextId,
          }),
        );
        expect(Predicate.isTagged(replay, 'PartyCommandAlreadyCommittedProblem')).toBe(true);
        expect((yield* h.fixture.evidence(h.coreEvidenceExecutor)).events).toHaveLength(evidence.events.length);
        expect((yield* h.fixture.evidence(h.coreEvidenceExecutor)).outbox).toHaveLength(evidence.outbox.length);
        expect((yield* h.resolve(detail.actionInvocationId)).state).toBe('COMMITTED');
        const changedIntent = yield* Effect.flip(
          h.correct(partyRef, a.officialIdentifierRef.resourceId, '1000004', commandOptions),
        );
        expect(Predicate.isTagged(changedIntent, 'PartyCommandConflictProblem')).toBe(true);
        const stale = yield* Effect.flip(
          h.correct(partyRef, a.officialIdentifierRef.resourceId, '26168685', yield* h.options),
        );
        expect(Predicate.isTagged(stale, 'PartyCommandConflictProblem')).toBe(true);
        const self = yield* Effect.flip(
          h.correct(partyRef, b.officialIdentifierRef.resourceId, '26168685', yield* h.options),
        );
        expect(Predicate.isTagged(self, 'PartyCommandConflictProblem')).toBe(true);
        const invalid = yield* Effect.flip(
          h.correct(partyRef, b.officialIdentifierRef.resourceId, '1000005', yield* h.options),
        );
        expect(Predicate.isTagged(invalid, 'PartyCommandConflictProblem')).toBe(true);
        expect(yield* h.rows()).toEqual(after);
        expect(yield* h.corrections()).toHaveLength(1);
        const denied = yield* Effect.flip(h.correctionDetail(corrected.correctionRef, h.fixture.denied));
        expect(Predicate.isTagged(denied, 'PartyCorrectionForbiddenProblem')).toBe(true);
        const foreign = yield* h.create();
        const wrongParty = yield* Effect.flip(
          h.correct(foreign, b.officialIdentifierRef.resourceId, '27074358', yield* h.options),
        );
        expect(Predicate.isTagged(wrongParty, 'PartyCommandConflictProblem')).toBe(true);
        expect(yield* h.rows()).toEqual(after);
        yield* h.moduleAccess(h.fixture.reader, 'grant');
        yield* Effect.addFinalizer(() => h.moduleAccess(h.fixture.reader, 'revoke').pipe(Effect.orDie));
        expect((yield* h.history(partyRef, h.fixture.reader)).items).toHaveLength(2);
        expect(
          Predicate.isTagged(
            yield* Effect.flip(h.correctionDetail(corrected.correctionRef, h.fixture.reader)),
            'PartyCorrectionForbiddenProblem',
          ),
        ).toBe(true);
        const noAuthority = yield* Effect.flip(
          h.correct(partyRef, b.officialIdentifierRef.resourceId, '27074358', yield* h.options, h.fixture.denied),
        );
        expect(Predicate.isTagged(noAuthority, 'PartyCommandForbiddenProblem')).toBe(true);
        const foreignFixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            actionKeys: [correctPartyFactAction.descriptor.actionKey],
            authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
            compositionRevision: h.composition.composition.revision,
            adminConnectionString: Redacted.make(h.connections.admin.connectionString),
            databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
            runtimeConnectionString: Redacted.make(h.connections.runtime.connectionString),
          }),
          (value) => value.close().pipe(Effect.orDie),
        );
        const foreignActor = { ...foreignFixture.manager, legalEntityId: foreignFixture.legalEntityId };
        expect((yield* h.history(partyRef, foreignActor)).items).toEqual([]);
        const crossTenant = yield* Effect.flip(
          h.correct(partyRef, b.officialIdentifierRef.resourceId, '27074358', yield* h.options, foreignActor),
        );
        expect(Predicate.isTagged(crossTenant, 'PartyCommandConflictProblem')).toBe(true);
        expect(yield* h.rows()).toEqual(after);
        yield* h.moduleAccess(h.principal, 'revoke');
        expect(
          Predicate.isTagged(yield* Effect.flip(h.history(partyRef)), 'PartyOfficialIdentifierHistoryForbiddenProblem'),
        ).toBe(true);
        yield* h.isolated.assertClonedSchema();
      }),
    120_000,
  );
});
