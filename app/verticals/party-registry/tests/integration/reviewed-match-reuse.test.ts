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
import { eq } from 'drizzle-orm';
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
  Result,
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
import { partyMatchDecisionReadApiLive } from '../../api/party-match-decision-read-server.ts';
import { duplicateCandidateDetailReadApiLive } from '../../api/duplicate-candidate-detail-read-server.ts';
import { partyRegistryApi } from '../../shared/api.ts';
import { ActionInvocationIdSchema } from '../../shared/domain/correction-contracts.ts';
import { partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import { committedCreateResult } from '../../shared/domain/matching-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { matchPartyAction } from '../../src/actions/match-party.action.ts';
import { resolveDuplicateCandidateMatchAction } from '../../src/actions/resolve-duplicate-candidate-match.action.ts';
import { archivePartyAction } from '../../src/actions/archive-party.action.ts';
import {
  createPartyWithAuthorization,
  matchPartyWithAuthorization,
  resolveDuplicateCandidateMatchWithAuthorization,
  recoverPartyCreateWithAuthorization,
  archivePartyWithAuthorization,
} from '../../src/api/party-command-client.ts';
import { executePartyMatchDecisionWithAuthorization } from '../../src/api/party-match-decision-client.ts';
import { executeDuplicateCandidateDetailWithAuthorization } from '../../src/api/duplicate-candidate-detail-client.ts';
import { makePartyDatabase } from '../../src/db/client.ts';
import {
  duplicateCandidateCases,
  parties,
  partyIdentifierClaims,
  partyMatchDecisions,
  partyOfficialIdentifiers,
} from '../../src/db/schema.ts';
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
    'public reviewed Create and Match reuse commit Party-only decisions and retain exact review provenance',
    () =>
      Effect.gen(function* reviewedMatchReuseNative() {
        const composition = yield* makeApplicationCompositionSnapshotFixture(
          [ultramodernApiMarker.appId],
          ultramodernApiMarker.buildMarker,
        );
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'schema-only',
          purpose: 'stabilization-1239-reviewed-match-reuse',
          compositionSnapshot: composition,
        });
        const native = yield* preparePartyReconciliationNative(isolated.connections);
        const connections = { ...isolated.connections, runtime: native.partyConfiguration };
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            actionKeys: [
              createPartyAction,
              matchPartyAction,
              resolveDuplicateCandidateMatchAction,
              archivePartyAction,
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
          .add(partyRegistryApi.groups.partyCommandRecovery)
          .add(partyRegistryApi.groups.partyMatchDecision)
          .add(partyRegistryApi.groups.duplicateCandidateDetail);
        const handlers = Layer.mergeAll(
          partyRegistryCommandsLive,
          partyRegistryCommandRecoveryLive,
          partyMatchDecisionReadApiLive,
          duplicateCandidateDetailReadApiLive,
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
        const runHttp = <Value, Failure, Requirements>(operation: Effect.Effect<Value, Failure, Requirements>) =>
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
        const candidate = {
          displayName: 'Reviewed external organization',
          evidenceRefs: ['reviewed-match/document'],
          officialIdentifiers: [
            { identifierType: 'ICO' as const, value: '27074358', verification: 'VERIFIED' as const },
          ],
          partyType: 'ORGANIZATION' as const,
          provenance: { method: 'DOCUMENT', source: 'reviewed-match-test' },
          subjectEvidence: [
            {
              basis: 'REVIEWED_DOCUMENT' as const,
              evidenceRef: 'reviewed-match/document',
              kind: 'ACTOR_ATTESTATION' as const,
              observedSubject: 'ORGANIZATION' as const,
              statement: 'Reviewed this concrete external organization',
              subjectKey: partySubjectKeyFromString(yield* nextId),
            },
          ],
          validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
        };
        yield* Effect.logInfo('1239 stage seed');
        const seed = yield* runHttp(
          createPartyWithAuthorization({ candidate }, yield* authorization(), yield* options),
        );
        assert.isOk(seed.outcome === 'CREATED');
        const weak = {
          ...candidate,
          officialIdentifiers: candidate.officialIdentifiers.map((identifier) => ({
            ...identifier,
            verification: 'UNVERIFIED' as const,
          })),
        };
        yield* Effect.logInfo('1239 stage open');
        const opened = yield* runHttp(
          createPartyWithAuthorization({ candidate: weak }, yield* authorization(), yield* options),
        );
        assert.isOk(opened.outcome === 'AMBIGUOUS');
        yield* Effect.logInfo('1239 stage review');
        const reviewed = yield* runHttp(
          resolveDuplicateCandidateMatchWithAuthorization(
            {
              caseRef: opened.caseRef,
              selectedPartyRef: seed.partyRef,
              expectedRevision: 1,
              reason: 'Reviewed unchanged weak evidence against the canonical Party',
            },
            yield* authorization(),
            yield* options,
          ),
        );
        expect(reviewed.partyRef).toEqual(seed.partyRef);
        const caseBefore = yield* admin
          .select()
          .from(duplicateCandidateCases)
          .where(eq(duplicateCandidateCases.candidateCaseId, opened.caseRef.resourceId));
        yield* Effect.logInfo('1239 stage new writers');
        const createOptions = yield* options;
        const createResult = yield* runHttp(
          createPartyWithAuthorization({ candidate: weak }, yield* authorization(), createOptions),
        ).pipe(Effect.result);
        const matchResult = yield* runHttp(
          matchPartyWithAuthorization({ candidate: weak }, yield* authorization(), yield* options),
        ).pipe(Effect.result);
        yield* Effect.logInfo('1239 writer outcomes', { create: createResult._tag, match: matchResult._tag });
        // Both actual writer paths must cross the native result CHECK successfully.
        expect(Result.isSuccess(createResult)).toBe(true);
        expect(Result.isSuccess(matchResult)).toBe(true);
        const created = Result.getOrThrow(createResult);
        const matched = Result.getOrThrow(matchResult);
        assert.isOk(created.outcome === 'MATCHED_EXISTING');
        expect(created.partyRef).toEqual(seed.partyRef);
        expect(matched.outcome).toBe('MATCHED');
        expect(matched.caseRef).toBe(null);
        const readDecision = (decisionRef: typeof created.decisionRef) =>
          Effect.gen(function* executeDecisionRead() {
            return yield* runHttp(
              executePartyMatchDecisionWithAuthorization({ decisionRef }, yield* authorization(), yield* nextId, {
                baseUrl,
                compositionRevision: composition.composition.revision,
              }),
            );
          });
        yield* Effect.logInfo('1239 stage decisions');
        for (const decisionRef of [created.decisionRef, matched.decisionRef]) {
          const decision = yield* readDecision(decisionRef);
          expect(decision.partyRef).toEqual(seed.partyRef);
          expect(decision.caseRef).toBe(null);
          expect(decision.evidenceExplanation).toEqual(
            expect.arrayContaining([expect.objectContaining({ reviewedCaseRef: opened.caseRef })]),
          );
        }
        yield* Effect.logInfo('1239 stage recovery');
        const createDecision = yield* readDecision(created.decisionRef);
        expect(committedCreateResult(createDecision)).toEqual(created);
        const stored = yield* admin
          .select()
          .from(partyMatchDecisions)
          .where(eq(partyMatchDecisions.matchDecisionId, created.decisionRef.resourceId));
        const [originalDecision] = stored;
        assert.isOk(originalDecision);
        const originalInvocationId = yield* Schema.decodeEffect(ActionInvocationIdSchema)(
          originalDecision.actionInvocationId,
        );
        const recovered = yield* runHttp(
          recoverPartyCreateWithAuthorization(
            { invocationId: originalInvocationId },
            () =>
              Effect.gen(function* recoveryAuthorization() {
                return {
                  credential: Redacted.make(yield* authorization()),
                  options: { baseUrl: new URL(baseUrl), compositionRevision: composition.composition.revision },
                };
              }),
            { baseUrl, compositionRevision: composition.composition.revision, correlationId: yield* nextId },
          ),
        );
        assert.isOk(Predicate.isTagged(recovered, 'PartyCreateRecovered'));
        expect(recovered.result).toEqual(created);
        const ownerSnapshot = () =>
          Effect.all({
            cases: admin
              .select()
              .from(duplicateCandidateCases)
              .where(eq(duplicateCandidateCases.tenantId, fixture.tenantId)),
            claims: admin
              .select()
              .from(partyIdentifierClaims)
              .where(eq(partyIdentifierClaims.tenantId, fixture.tenantId)),
            identifiers: admin
              .select()
              .from(partyOfficialIdentifiers)
              .where(eq(partyOfficialIdentifiers.tenantId, fixture.tenantId)),
            decisions: admin
              .select()
              .from(partyMatchDecisions)
              .where(eq(partyMatchDecisions.tenantId, fixture.tenantId)),
            parties: admin.select().from(parties).where(eq(parties.tenantId, fixture.tenantId)),
          });
        yield* Effect.logInfo('1239 stage replay');
        const beforeReplay = yield* ownerSnapshot();
        const replayEvidence = yield* fixture.evidence(coreEvidenceExecutor);
        const replayError = yield* Effect.flip(
          runHttp(
            createPartyWithAuthorization({ candidate: weak }, yield* authorization(), {
              ...createOptions,
              correlationId: yield* nextId,
            }),
          ),
        );
        expect(Predicate.isTagged(replayError, 'PartyCommandAlreadyCommittedProblem')).toBe(true);
        expect(yield* ownerSnapshot()).toEqual(beforeReplay);
        const afterReplayEvidence = yield* fixture.evidence(coreEvidenceExecutor);
        expect(afterReplayEvidence.events).toEqual(replayEvidence.events);
        expect(afterReplayEvidence.outbox).toEqual(replayEvidence.outbox);
        expect(afterReplayEvidence.audits).toEqual(replayEvidence.audits);

        yield* Effect.logInfo('1239 stage concurrent new invocations');
        const concurrent = yield* Effect.all(
          [
            runHttp(createPartyWithAuthorization({ candidate: weak }, yield* authorization(), yield* options)),
            runHttp(matchPartyWithAuthorization({ candidate: weak }, yield* authorization(), yield* options)),
          ],
          { concurrency: 2 },
        );
        expect(concurrent[0]).toMatchObject({ outcome: 'MATCHED_EXISTING', partyRef: seed.partyRef });
        expect(concurrent[1]).toMatchObject({ outcome: 'MATCHED', caseRef: null });
        for (const result of concurrent) {
          const decision = yield* readDecision(result.decisionRef);
          expect(decision.partyRef).toEqual(seed.partyRef);
          expect(decision.caseRef).toBe(null);
          expect(decision.evidenceExplanation).toEqual(
            expect.arrayContaining([expect.objectContaining({ reviewedCaseRef: opened.caseRef })]),
          );
        }
        expect((yield* ownerSnapshot()).cases).toEqual(caseBefore);
        expect((yield* ownerSnapshot()).parties).toEqual(beforeReplay.parties);
        expect((yield* ownerSnapshot()).decisions).toHaveLength(beforeReplay.decisions.length + 2);

        yield* Effect.logInfo('1239 stage rollback');
        const beforeRollback = yield* ownerSnapshot();
        const rollbackEvidence = yield* fixture.evidence(coreEvidenceExecutor);
        const rollbackOptions = yield* options;
        fixture.faultNextTransaction('rollback');
        const rollbackError = yield* Effect.flip(
          runHttp(createPartyWithAuthorization({ candidate: weak }, yield* authorization(), rollbackOptions)),
        );
        expect(Predicate.isTagged(rollbackError, 'PartyCommandUnavailableProblem')).toBe(true);
        expect(yield* ownerSnapshot()).toEqual(beforeRollback);
        const afterRollbackEvidence = yield* fixture.evidence(coreEvidenceExecutor);
        expect(afterRollbackEvidence.events).toEqual(rollbackEvidence.events);
        expect(afterRollbackEvidence.outbox).toEqual(rollbackEvidence.outbox);
        expect(afterRollbackEvidence.audits).toEqual(rollbackEvidence.audits);
        const retry = yield* runHttp(
          createPartyWithAuthorization({ candidate: weak }, yield* authorization(), {
            ...rollbackOptions,
            correlationId: yield* nextId,
          }),
        );
        expect(retry).toMatchObject({ outcome: 'MATCHED_EXISTING', partyRef: seed.partyRef });
        expect((yield* ownerSnapshot()).decisions).toHaveLength(beforeRollback.decisions.length + 1);

        // An impossible double result remains rejected by the actual unchanged SQL CHECK.
        const invalidDecisionId = yield* nextId;
        const invalidResult = yield* admin
          .transaction((transaction) =>
            transaction.insert(partyMatchDecisions).values({
              ...originalDecision,
              candidateCaseId: opened.caseRef.resourceId,
              matchDecisionId: invalidDecisionId,
            }),
          )
          .pipe(Effect.exit);
        assert.isOk(Exit.isFailure(invalidResult));
        expect(
          Option.exists(
            findPostgresFailure(invalidResult.cause),
            ({ code, constraint }) => code === '23514' && constraint === 'party_match_decisions_result_ck',
          ),
        ).toBe(true);
        expect((yield* ownerSnapshot()).decisions).toHaveLength(beforeRollback.decisions.length + 1);

        yield* Effect.logInfo('1239 stage changed evidence and authority');
        const changed = { ...weak, evidenceRefs: [...weak.evidenceRefs, 'reviewed-match/new-document'] };
        const successor = yield* runHttp(
          matchPartyWithAuthorization(
            { candidate: changed, priorCaseRef: opened.caseRef },
            yield* authorization(),
            yield* options,
          ),
        );
        assert.isOk(successor.outcome === 'AMBIGUOUS' && successor.caseRef !== null);
        expect(successor.caseRef).not.toEqual(opened.caseRef);
        const successorRead = yield* runHttp(
          executeDuplicateCandidateDetailWithAuthorization(
            { caseRef: successor.caseRef },
            yield* authorization(),
            yield* nextId,
            { baseUrl, compositionRevision: composition.composition.revision },
          ),
        );
        expect(successorRead.priorCaseRef).toEqual(opened.caseRef);
        expect(successorRead.lifecycleState).toBe('OPEN');
        const beforeDenials = yield* ownerSnapshot();
        const resolutionPayload = {
          caseRef: successor.caseRef,
          selectedPartyRef: seed.partyRef,
          expectedRevision: 999,
          reason: 'Stale reviewer revision must not commit',
        };
        expect(
          Predicate.isTagged(
            yield* Effect.flip(
              runHttp(
                resolveDuplicateCandidateMatchWithAuthorization(
                  resolutionPayload,
                  yield* authorization(),
                  yield* options,
                ),
              ),
            ),
            'PartyCommandConflictProblem',
          ),
        ).toBe(true);
        expect(
          Predicate.isTagged(
            yield* Effect.flip(
              runHttp(
                resolveDuplicateCandidateMatchWithAuthorization(
                  { ...resolutionPayload, expectedRevision: 1 },
                  yield* authorization({ ...fixture.denied, legalEntityId: fixture.legalEntityId }),
                  yield* options,
                ),
              ),
            ),
            'PartyCommandForbiddenProblem',
          ),
        ).toBe(true);
        expect(yield* ownerSnapshot()).toEqual(beforeDenials);
        const foreignFixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            actionKeys: [createPartyAction, matchPartyAction, resolveDuplicateCandidateMatchAction].map(
              (action) => action.descriptor.actionKey,
            ),
            authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
            compositionRevision: composition.composition.revision,
            adminConnectionString: Redacted.make(connections.admin.connectionString),
            databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
            runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
          }),
          (value) => value.close().pipe(Effect.orDie),
        );
        const foreignActor = { ...foreignFixture.manager, legalEntityId: foreignFixture.legalEntityId };
        const foreignCreated = yield* runHttp(
          createPartyWithAuthorization({ candidate }, yield* authorization(foreignActor), yield* options),
        );
        assert.isOk(foreignCreated.outcome === 'CREATED');
        expect(foreignCreated.partyRef.tenantId).toBe(foreignFixture.tenantId);
        expect(foreignCreated.partyRef).not.toEqual(seed.partyRef);
        expect(
          Predicate.isTagged(
            yield* Effect.flip(
              runHttp(
                executePartyMatchDecisionWithAuthorization(
                  { decisionRef: created.decisionRef },
                  yield* authorization(foreignActor),
                  yield* nextId,
                  { baseUrl, compositionRevision: composition.composition.revision },
                ),
              ),
            ),
            'PartyMatchDecisionNotFoundProblem',
          ),
        ).toBe(true);
        expect(
          Predicate.isTagged(
            yield* Effect.flip(
              runHttp(
                executeDuplicateCandidateDetailWithAuthorization(
                  { caseRef: opened.caseRef },
                  yield* authorization(foreignActor),
                  yield* nextId,
                  { baseUrl, compositionRevision: composition.composition.revision },
                ),
              ),
            ),
            'DuplicateCandidateDetailNotFoundProblem',
          ),
        ).toBe(true);
        expect(
          Predicate.isTagged(
            yield* Effect.flip(
              runHttp(
                matchPartyWithAuthorization(
                  { candidate: weak, priorCaseRef: opened.caseRef },
                  yield* authorization(foreignActor),
                  yield* options,
                ),
              ),
            ),
            'PartyCommandUnprocessableProblem',
          ),
        ).toBe(true);
        expect(
          Predicate.isTagged(
            yield* Effect.flip(
              runHttp(
                resolveDuplicateCandidateMatchWithAuthorization(
                  { ...resolutionPayload, expectedRevision: 1, selectedPartyRef: foreignCreated.partyRef },
                  yield* authorization(),
                  yield* options,
                ),
              ),
            ),
            'PartyCommandConflictProblem',
          ),
        ).toBe(true);
        expect(yield* ownerSnapshot()).toEqual(beforeDenials);
        yield* Effect.logInfo('1239 stage incompatible and competing targets');
        const incompatible = yield* runHttp(
          matchPartyWithAuthorization(
            {
              candidate: {
                ...weak,
                partyType: 'PERSON',
                subjectEvidence: weak.subjectEvidence.map((evidence) => ({
                  ...evidence,
                  observedSubject: 'PERSON' as const,
                })),
              },
            },
            yield* authorization(),
            yield* options,
          ),
        );
        expect(incompatible.outcome).toBe('AMBIGUOUS');
        const competingSubjectKey = partySubjectKeyFromString(yield* nextId);
        const secondCanonical = yield* runHttp(
          createPartyWithAuthorization(
            {
              candidate: {
                ...candidate,
                displayName: 'Independent competing organization',
                officialIdentifiers: [{ identifierType: 'ICO', value: '26168685', verification: 'VERIFIED' }],
                subjectEvidence: candidate.subjectEvidence.map((evidence) => ({
                  ...evidence,
                  subjectKey: competingSubjectKey,
                })),
              },
            },
            yield* authorization(),
            yield* options,
          ),
        );
        assert.isOk(secondCanonical.outcome === 'CREATED');
        const beforeCompeting = yield* ownerSnapshot();
        const competing = yield* runHttp(
          matchPartyWithAuthorization(
            {
              candidate: {
                ...candidate,
                officialIdentifiers: [
                  ...candidate.officialIdentifiers,
                  { identifierType: 'ICO', value: '26168685', verification: 'VERIFIED' },
                ],
              },
            },
            yield* authorization(),
            yield* options,
          ),
        );
        expect(competing.outcome).toBe('AMBIGUOUS');
        const competingDecision = yield* readDecision(competing.decisionRef);
        expect(competingDecision.partyRef).toBe(null);
        expect(competingDecision.caseRef).not.toBe(null);
        const afterCompeting = yield* ownerSnapshot();
        expect(afterCompeting.claims).toEqual(beforeCompeting.claims);
        expect(afterCompeting.identifiers).toEqual(beforeCompeting.identifiers);
        expect(afterCompeting.parties).toEqual(beforeCompeting.parties);
        yield* Effect.logInfo('1239 stage retained case');
        const caseRead = yield* runHttp(
          executeDuplicateCandidateDetailWithAuthorization(
            { caseRef: opened.caseRef },
            yield* authorization(),
            yield* nextId,
            { baseUrl, compositionRevision: composition.composition.revision },
          ),
        );
        expect(caseRead.lifecycleState).toBe('RESOLVED');
        expect(caseRead.resolutionOutcome).toBe('MATCH_EXISTING');
        expect(
          yield* admin
            .select()
            .from(duplicateCandidateCases)
            .where(eq(duplicateCandidateCases.candidateCaseId, opened.caseRef.resourceId)),
        ).toEqual(caseBefore);
        expect(yield* admin.select().from(parties).where(eq(parties.tenantId, fixture.tenantId))).toHaveLength(2);
        yield* Effect.logInfo('1239 stage archived target');
        const [currentParty] = yield* admin.select().from(parties).where(eq(parties.partyId, seed.partyRef.resourceId));
        assert.isOk(currentParty);
        yield* runHttp(
          archivePartyWithAuthorization(
            {
              partyRef: seed.partyRef,
              expectedRevision: currentParty.revision,
              reason: 'Closed relationship after reviewed reuse',
            },
            yield* authorization(),
            yield* options,
          ),
        );
        const afterArchive = yield* runHttp(
          createPartyWithAuthorization({ candidate: weak }, yield* authorization(), yield* options),
        );
        expect(afterArchive.outcome).toBe('AMBIGUOUS');
        expect(
          yield* admin
            .select()
            .from(duplicateCandidateCases)
            .where(eq(duplicateCandidateCases.candidateCaseId, opened.caseRef.resourceId)),
        ).toEqual(caseBefore);
        expect(yield* admin.select().from(parties).where(eq(parties.tenantId, fixture.tenantId))).toHaveLength(2);
      }),
  );
});
