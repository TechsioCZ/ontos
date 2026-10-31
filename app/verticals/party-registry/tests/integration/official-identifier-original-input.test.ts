// @rstest-environment happy-dom
// @rstest-environment-options {"url":"https://party.ontos.test"}
import { DatabaseConfig, findPostgresFailure } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT } from '@app/party-registry-identity-contracts';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { and, eq } from 'drizzle-orm';
import {
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Effect,
  Exit,
  Layer,
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
import { partyRegistryCommandsLive } from '../../api/party-command-server.ts';
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
} from '../../src/api/party-command-client.ts';
import { executePartyOfficialIdentifierHistoryWithAuthorization } from '../../src/api/party-official-identifier-history-client.ts';
import { makePartyDatabase } from '../../src/db/client.ts';
import { partyIdentifierClaims, partyOfficialIdentifiers } from '../../src/db/schema.ts';
import {
  makePartyReconciliationGateway,
  preparePartyReconciliationNative,
} from '../support/party-reconciliation-native.fixture.ts';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const emptyContext = Context.makeUnsafe<unknown>(new Map());

it.layer(
  NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCrypto.layer)),
  { excludeTestServices: true },
)((suite) => {
  suite.effect(
    'generated standalone Add retains truthful ICO source through native commit, history, reuse, retry and rollback',
    () =>
      Effect.gen(function* originalIdentifierInputNative() {
        const composition = yield* makeApplicationCompositionSnapshotFixture(
          [ultramodernApiMarker.appId],
          ultramodernApiMarker.buildMarker,
        );
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'schema-only',
          purpose: 'stabilization-1281-original-input',
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
        const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
        const gateway = yield* makePartyReconciliationGateway(native, composition);
        const { issuer, jwks } = gateway;
        const authorization = (actor = principal) => gateway.authorization(actor);
        const redemption = GatewayAssertionRedemptionLive.pipe(
          Layer.provide(GatewayAssertionRedemptionDatabaseLive),
          Layer.provide(Layer.succeed(DatabaseConfig, connections.runtime)),
        );
        const api = HttpApi.make('PartyRegistryApi')
          .add(partyRegistryApi.groups.partyCommands)
          .add(partyRegistryApi.groups.partyOfficialIdentifierHistory);
        const handlers = Layer.mergeAll(partyRegistryCommandsLive, partyOfficialIdentifierHistoryReadApiLive).pipe(
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
        ) {
          return yield* runHttp(
            addPartyOfficialIdentifierWithAuthorization(
              {
                identifier: { identifierType, value, verification: 'UNVERIFIED' },
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
            executePartyOfficialIdentifierHistoryWithAuthorization(
              { partyRef },
              yield* authorization(actor),
              yield* nextId,
              { baseUrl, compositionRevision: composition.composition.revision },
            ),
          );
        });
        const rows = () =>
          admin.select().from(partyOfficialIdentifiers).where(eq(partyOfficialIdentifiers.tenantId, fixture.tenantId));
        const firstParty = yield* create();
        const firstOptions = yield* options;
        const first = yield* add(firstParty, '1000004', firstOptions);
        const firstRows = yield* rows();
        expect(firstRows).toHaveLength(1);
        const [original] = firstRows;
        assert.isOk(original);
        expect(original.normalizedValue).toBe('01000004');
        expect(original.originalInputDigits).toBe('1000004');
        expect(original.acceptedByPrincipalId).toBe(principal.principalId);
        expect(original.provenanceMethod).toBe('MANUAL');
        expect(original.provenanceSource).toBe('original-input-test');
        expect(original.policyVersion).toBe('party-official-identifier.v1');
        expect(original.externalEvidence).toBe(null);
        const firstHistory = yield* history(firstParty);
        expect(firstHistory.items[0]?.originalInputDigits).toBe('1000004');
        expect(firstHistory.items[0]?.normalizedValue).toBe('01000004');
        const beforeRetry = yield* fixture.evidence(coreEvidenceExecutor);
        const replay = yield* add(firstParty, '1000004', { ...firstOptions, correlationId: yield* nextId }).pipe(
          Effect.exit,
        );
        assert.isOk(Exit.isFailure(replay));
        expect(
          Predicate.isTagged(Option.getOrThrow(Exit.findErrorOption(replay)), 'PartyCommandAlreadyCommittedProblem'),
        ).toBe(true);
        expect(yield* rows()).toEqual(firstRows);
        const afterRetry = yield* fixture.evidence(coreEvidenceExecutor);
        expect(afterRetry.events).toHaveLength(beforeRetry.events.length);
        expect(afterRetry.outbox).toHaveLength(beforeRetry.outbox.length);
        expect(afterRetry.audits).toHaveLength(beforeRetry.audits.length);
        const reuse = yield* add(firstParty, '01000004', yield* options);
        expect(reuse.officialIdentifierRef).toEqual(first.officialIdentifierRef);
        expect(yield* rows()).toEqual(firstRows);
        const secondParty = yield* create();
        const second = yield* add(secondParty, '01000004', yield* options);
        expect((yield* history(secondParty)).items[0]?.originalInputDigits).toBe('01000004');
        const dic = yield* add(secondParty, 'cz27074358', yield* options, 'CZ_DIC');
        const dicRow = (yield* rows()).find((row) => row.officialIdentifierId === dic.officialIdentifierRef.resourceId);
        expect(dicRow?.originalInputDigits).toBe(null);
        expect(dicRow?.normalizedValue).toBe('CZ27074358');
        const countBeforeInvalid = (yield* rows()).length;
        for (const value of ['1000005', '1 000004', '001000004']) {
          const rejected = yield* add(secondParty, value, yield* options).pipe(Effect.exit);
          expect(Exit.isFailure(rejected)).toBe(true);
        }
        expect(yield* rows()).toHaveLength(countBeforeInvalid);
        const denied = yield* history(firstParty, { ...fixture.denied, legalEntityId: fixture.legalEntityId }).pipe(
          Effect.exit,
        );
        assert.isOk(Exit.isFailure(denied));
        expect(
          Predicate.isTagged(
            Option.getOrThrow(Exit.findErrorOption(denied)),
            'PartyOfficialIdentifierHistoryForbiddenProblem',
          ),
        ).toBe(true);
        const foreignFixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            actionKeys: [addPartyOfficialIdentifierAction.descriptor.actionKey],
            authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
            compositionRevision: composition.composition.revision,
            adminConnectionString: Redacted.make(connections.admin.connectionString),
            databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
            runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
          }),
          (value) => value.close().pipe(Effect.orDie),
        );
        const foreignActor = { ...foreignFixture.manager, legalEntityId: foreignFixture.legalEntityId };
        expect((yield* history(firstParty, foreignActor)).items).toEqual([]);
        const beforeForeignWrite = yield* rows();
        const foreignAddError = yield* Effect.flip(add(firstParty, '27074358', yield* options, 'ICO', foreignActor));
        expect(Predicate.isTagged(foreignAddError, 'PartyCommandNotFoundProblem')).toBe(true);
        const deniedAddError = yield* Effect.flip(
          add(firstParty, '27074358', yield* options, 'ICO', {
            ...fixture.denied,
            legalEntityId: fixture.legalEntityId,
          }),
        );
        expect(Predicate.isTagged(deniedAddError, 'PartyCommandForbiddenProblem')).toBe(true);
        expect(yield* rows()).toEqual(beforeForeignWrite);
        const beforeRollback = yield* fixture.evidence(coreEvidenceExecutor);
        fixture.faultNextTransaction('rollback');
        const rollbackOptions = yield* options;
        const rolledBack = yield* add(firstParty, '27074358', rollbackOptions).pipe(Effect.exit);
        expect(Exit.isFailure(rolledBack)).toBe(true);
        expect(
          (yield* rows()).some((row) => row.partyId === firstParty.resourceId && row.normalizedValue === '27074358'),
        ).toBe(false);
        const afterRollback = yield* fixture.evidence(coreEvidenceExecutor);
        expect(afterRollback.events).toHaveLength(beforeRollback.events.length);
        expect(afterRollback.outbox).toHaveLength(beforeRollback.outbox.length);
        expect(afterRollback.audits).toHaveLength(beforeRollback.audits.length);
        yield* add(firstParty, '27074358', { ...rollbackOptions, correlationId: yield* nextId });
        expect(
          (yield* rows()).filter((row) => row.partyId === firstParty.resourceId && row.normalizedValue === '27074358'),
        ).toHaveLength(1);
        const claims = yield* admin
          .select()
          .from(partyIdentifierClaims)
          .where(eq(partyIdentifierClaims.tenantId, fixture.tenantId));
        expect(claims).toEqual([]);
        const legacyId = yield* nextId;
        // Old writers omitted this nullable additive column. Preserve that absence as unknown.
        yield* admin.insert(partyOfficialIdentifiers).values({
          acceptedByActionInvocationId: original.acceptedByActionInvocationId,
          acceptedByPrincipalId: original.acceptedByPrincipalId,
          identifierTypeKey: 'ICO',
          namespace: 'CZ:ICO',
          normalizedValue: '26168685',
          officialIdentifierId: legacyId,
          partyId: secondParty.resourceId,
          policyVersion: original.policyVersion,
          provenanceMethod: original.provenanceMethod,
          provenanceSource: original.provenanceSource,
          tenantId: fixture.tenantId,
          validFrom: original.validFrom,
          verificationState: 'UNVERIFIED',
        });
        const legacyReuse = yield* add(secondParty, '26168685', yield* options);
        expect(legacyReuse.officialIdentifierRef.resourceId).toBe(legacyId);
        expect(
          (yield* history(secondParty)).items.find((item) => item.officialIdentifierRef.resourceId === legacyId)
            ?.originalInputDigits,
        ).toBe(null);
        for (const originalInputDigits of ['abc', '001000004', '1000005', '1000004 ']) {
          const failure = yield* admin
            .transaction((transaction) =>
              transaction
                .update(partyOfficialIdentifiers)
                .set({ originalInputDigits })
                .where(eq(partyOfficialIdentifiers.officialIdentifierId, second.officialIdentifierRef.resourceId)),
            )
            .pipe(Effect.exit);
          assert.isOk(Exit.isFailure(failure));
          expect(
            Option.exists(
              findPostgresFailure(failure.cause),
              ({ code, constraint }) =>
                code === '23514' && constraint === 'party_official_identifiers_original_input_digits_ck',
            ),
          ).toBe(true);
        }
        const dicFailure = yield* admin
          .transaction((transaction) =>
            transaction
              .update(partyOfficialIdentifiers)
              .set({ originalInputDigits: '27074358' })
              .where(eq(partyOfficialIdentifiers.officialIdentifierId, dic.officialIdentifierRef.resourceId)),
          )
          .pipe(Effect.exit);
        assert.isOk(Exit.isFailure(dicFailure));
        expect(Option.exists(findPostgresFailure(dicFailure.cause), ({ code }) => code === '23514')).toBe(true);
        yield* runHttp(
          endPartyOfficialIdentifierWithAuthorization(
            {
              officialIdentifierRef: first.officialIdentifierRef,
              reason: 'The asserted validity period ended',
              validTo: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
            },
            yield* authorization(),
            yield* options,
          ),
        );
        const ended = (yield* history(firstParty)).items.find(
          (item) => item.officialIdentifierRef.resourceId === first.officialIdentifierRef.resourceId,
        );
        expect(ended?.originalInputDigits).toBe('1000004');
        expect(ended?.state).toBe('ENDED');
        const correction = yield* runHttp(
          correctPartyFactWithAuthorization(
            yield* Schema.decodeUnknownEffect(IdentityCorrectionCommandSchema)({
              partyId: secondParty.resourceId,
              targetAssertionId: second.officialIdentifierRef.resourceId,
              factKind: 'OFFICIAL_IDENTIFIER',
              replacementValue: '27074358',
              reasonCode: 'WRONG_IDENTITY_VALUE',
              reasonDetail: 'Document review established an historical input error',
              evidenceSource: 'DOCUMENT',
              evidenceRefs: ['original-input/correction'],
              policyVersion: 'party-correction.v1',
              provenance: { method: 'DOCUMENT', source: 'original-input-test' },
            }),
            yield* authorization(),
            yield* options,
          ),
        );
        expect(correction).toBeDefined();
        const corrected = yield* history(secondParty);
        expect(
          corrected.items.find(
            (item) => item.officialIdentifierRef.resourceId === second.officialIdentifierRef.resourceId,
          )?.originalInputDigits,
        ).toBe('01000004');
        const preserved = yield* admin
          .select()
          .from(partyOfficialIdentifiers)
          .where(
            and(
              eq(partyOfficialIdentifiers.tenantId, fixture.tenantId),
              eq(partyOfficialIdentifiers.officialIdentifierId, original.officialIdentifierId),
            ),
          );
        expect(preserved[0]?.acceptedByActionInvocationId).toBe(original.acceptedByActionInvocationId);
      }),
  );
});
