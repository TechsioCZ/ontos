import { computeActionRequestHash } from '@app/core-runtime/access/enforcement';
import { PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT } from '@app/party-registry-identity-contracts';
import {
  createPartyRequestIdentity,
  updatePartyRequestIdentity,
  correctPartyFactRequestIdentity,
} from '../../shared/domain/native-action-request-identity.ts';
import { CreatePartyPayloadSchema } from '../../shared/actions/create-party.ts';
import { UpdatePartyPayloadSchema } from '../../shared/actions/update-party.ts';
import { CorrectPartyFactPayloadSchema } from '../../shared/actions/correct-party-fact.ts';
import { partySourceEffectReceiptReadApiLive } from '../../api/party-source-effect-receipt-read-server.ts';
import { executePartySourceEffectReceiptWithAuthorization } from '../../src/api/party-source-effect-receipt-client.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';
// @rstest-environment happy-dom
// @rstest-environment-options {"url":"https://party.ontos.test"}
import { DatabaseConfig, findPostgresFailure } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makePartyDeniedAccess } from '../support/live-access-authority.ts';
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
import { ActionInvocationIdSchema, TargetAssertionIdSchema } from '../../shared/domain/correction-contracts.ts';
import { PartyIdSchema, partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import { committedCreateResult } from '../../shared/domain/matching-contracts.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { matchPartyAction } from '../../src/actions/match-party.action.ts';
import { resolveDuplicateCandidateMatchAction } from '../../src/actions/resolve-duplicate-candidate-match.action.ts';
import { updatePartyAction } from '../../src/actions/update-party.action.ts';
import { correctPartyFactAction } from '../../src/actions/correct-party-fact.action.ts';
import { archivePartyAction } from '../../src/actions/archive-party.action.ts';
import {
  createPartyWithAuthorization,
  matchPartyWithAuthorization,
  resolveDuplicateCandidateMatchWithAuthorization,
  recoverPartyCreateWithAuthorization,
  archivePartyWithAuthorization,
  updatePartyWithAuthorization,
  correctPartyFactWithAuthorization,
} from '../../src/api/party-command-client.ts';
import { executePartyMatchDecisionWithAuthorization } from '../../src/api/party-match-decision-client.ts';
import { executeDuplicateCandidateDetailWithAuthorization } from '../../src/api/duplicate-candidate-detail-client.ts';
import { makePartyDatabase } from '../../src/db/client.ts';
import {
  duplicateCandidateCases,
  parties,
  partyCreateSourceReceipts,
  partySourceEffectReceipts,
  partyFactAssertions,
  partyMatchDecisions,
  partyOfficialIdentifiers,
} from '../../src/db/schema.ts';
import { PartyClientSourcePrivacy } from '../../src/services/party-client-source-evidence.service.ts';
import type { PartySourceCreateTarget } from '../../src/services/party-client-source-evidence.service.ts';
import {
  makePartyReconciliationGateway,
  makePartyReconciliationComposition,
  preparePartyReconciliationNative,
} from '../support/party-reconciliation-native.fixture.ts';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const emptyContext = Context.makeUnsafe<unknown>(new Map());

it.layer(
  NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCrypto.layer)),
  { excludeTestServices: true },
)((suite) => {
  suite.effect('governed Party source lifecycle preserves review provenance, exact receipts and current Privacy', () =>
    Effect.gen(function* reviewedMatchReuseNative() {
      const composition = yield* makePartyReconciliationComposition();
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        mode: 'schema-only',
        purpose: 'stabilization-1239-reviewed-match-reuse',
        compositionSnapshot: composition,
      });
      const native = yield* preparePartyReconciliationNative(isolated.connections);
      const connections = { ...isolated.connections, runtime: native.partyConfiguration };
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          access: 'allowed',
          actionKeys: [
            createPartyAction,
            matchPartyAction,
            resolveDuplicateCandidateMatchAction,
            archivePartyAction,
            updatePartyAction,
            correctPartyFactAction,
          ].map((action) => action.descriptor.actionKey),
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          authenticationSubjectTypes: ['user', 'api_key'],
          managerAuthenticationMethod: 'api_key',
          compositionRevision: composition.composition.revision,
          ownerRegistration: partyRegistryBackendRegistration,
          adminConnectionString: Redacted.make(connections.admin.connectionString),
          runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
          // Scoped native writers need session-setting authority: this isolated target's shared runtime
          // credential. The dedicated request role above still serves every Action and Read.
          bootstrapConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
          databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
        }),
        (value) => value.close().pipe(Effect.orDie),
      );
      const deniedAccess = makePartyDeniedAccess();
      const fixtureLayer = fixture.layer.pipe(Layer.provide(deniedAccess.layer));
      const adminLayer = PgClient.layer({ url: Redacted.make(connections.admin.connectionString) }).pipe(
        Layer.provideMerge(Reactivity.layer),
      );
      const adminContext = yield* Layer.build(adminLayer);
      const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
      const { executor: admin } = yield* makePartyDatabase(connections.admin);
      const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
      const source = {
        issuer: 'internal-contract-fixture',
        namespace: 'customers',
        recordType: 'customer',
        routeRef: 'internal-contract-party-route',
      };
      const sourceBindings = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
        {
          ...source,
          authMethod: principal.authMethod,
          principalId: principal.principalId,
          tenantId: principal.tenantId,
        },
      ]);
      const checkedTargets: PartySourceCreateTarget[] = [];
      const targetAllowed = { PARTY: true, DUPLICATE_CANDIDATE: true };
      const sourcePrivacy = PartyClientSourcePrivacy.of({
        checkImport: ({ intent }) =>
          Effect.sync(() => {
            if (intent.operation === 'RECOVER_CREATE') {
              checkedTargets.push(intent.target);
            }
            return ('partyId' in intent && !targetAllowed.PARTY) ||
              ('target' in intent && intent.target !== undefined && !targetAllowed[intent.target.kind])
              ? 'DENIED'
              : 'ALLOWED';
          }),
      });
      const gateway = yield* makePartyReconciliationGateway(native, composition);
      const { issuer, jwks } = gateway;
      const authorization = (actor: Parameters<typeof gateway.authorization>[0] = principal) =>
        gateway.authorization(actor);
      const redemption = GatewayAssertionRedemptionLive.pipe(
        Layer.provide(GatewayAssertionRedemptionDatabaseLive),
        Layer.provide(Layer.succeed(DatabaseConfig, connections.runtime)),
      );
      const api = HttpApi.make('PartyRegistryApi')
        .add(partyRegistryApi.groups.partyCommands)
        .add(partyRegistryApi.groups.partyCommandRecovery)
        .add(partyRegistryApi.groups.partyMatchDecision)
        .add(partyRegistryApi.groups.duplicateCandidateDetail)
        .add(partyRegistryApi.groups.partySourceEffectReceipt);
      const config = ConfigProvider.fromUnknown({
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: jwks,
        ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: sourceBindings,
      });
      const handlers = Layer.mergeAll(
        partyRegistryCommandsLive,
        partyRegistryCommandRecoveryLive,
        partyMatchDecisionReadApiLive,
        duplicateCandidateDetailReadApiLive,
        partySourceEffectReceiptReadApiLive,
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            ActionPrincipalVerifierLive,
            makeActiveApplicationCompositionLayer(Effect.succeed(composition)),
          ).pipe(Layer.provide(ActiveApplicationCompositionSourceLive), Layer.provide(FetchHttpClient.layer)),
        ),
        Layer.provide(redemption),
        Layer.provide(fixtureLayer),
        Layer.provide(ConfigProvider.layer(config)),
      );
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(api).pipe(
              Layer.provide(handlers),
              Layer.provideMerge(fixtureLayer),
              Layer.provide(HttpServer.layerServices),
              Layer.provide(NodeCrypto.layer),
            ),
            { disableLogger: true },
          ),
        ),
        (value) => Effect.promise(value.dispose.bind(value)).pipe(Effect.orDie),
      );
      const requestContext = emptyContext.pipe(
        Context.add(PartyClientSourcePrivacy, sourcePrivacy),
        Context.add(ConfigProvider.ConfigProvider, config),
      );
      const inMemoryFetch: typeof fetch = (input, init) => app.handler(new Request(input, init), requestContext);
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
        businessName: 'Reviewed external organization',
        evidenceRefs: ['reviewed-match/document'],
        officialIdentifiers: [{ identifierType: 'ICO' as const, value: '27074358' }],
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
      const seed = yield* runHttp(createPartyWithAuthorization({ candidate }, yield* authorization(), yield* options));
      assert.isOk(seed.outcome === 'CREATED');
      const weak = {
        ...candidate,
        officialIdentifiers: candidate.officialIdentifiers.map((identifier) => ({
          ...identifier,
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
          identifiers: admin
            .select()
            .from(partyOfficialIdentifiers)
            .where(eq(partyOfficialIdentifiers.tenantId, fixture.tenantId)),
          decisions: admin.select().from(partyMatchDecisions).where(eq(partyMatchDecisions.tenantId, fixture.tenantId)),
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
      expect((yield* ownerSnapshot()).cases).toEqual(beforeReplay.cases);
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
      // v2: the one access gate decides this Action (O62); a principal it does not admit is
      // refused before any owner work. The fixture scripts its gate per capability, so the refusal
      // of this one principal is named on the fixture's own per-request owner seam (the removed
      // SpiceDB executor tuple no longer refuses anyone).
      deniedAccess.deny(fixture.denied.principalId);
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
          access: 'allowed',
          actionKeys: [createPartyAction, matchPartyAction, resolveDuplicateCandidateMatchAction].map(
            (action) => action.descriptor.actionKey,
          ),
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: composition.composition.revision,
          ownerRegistration: partyRegistryBackendRegistration,
          adminConnectionString: Redacted.make(connections.admin.connectionString),
          runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
          // Scoped native writers need session-setting authority: this isolated target's shared runtime
          // credential. The dedicated request role above still serves every Action and Read.
          bootstrapConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
          databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
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
              businessName: 'Independent competing organization',
              officialIdentifiers: [{ identifierType: 'ICO', value: '26168685' }],
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
              officialIdentifiers: [...candidate.officialIdentifiers, { identifierType: 'ICO', value: '26168685' }],
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

      const sourceCandidate = {
        ...candidate,
        businessName: 'Independent internal source organization',
        evidenceRefs: [],
        officialIdentifiers: [],
        subjectEvidence: [
          {
            kind: 'CLIENT_SOURCE_ASSERTION' as const,
            observedSubject: 'ORGANIZATION' as const,
            occurrenceId: 'fixture-revision-1',
            recordId: 'fixture-record-1',
            source,
            sourceObservedAt: candidate.validFrom,
            statement: 'Internal fixture declares this organization',
            subjectKey: partySubjectKeyFromString(yield* nextId),
          },
        ],
      };
      const createSource = (value = sourceCandidate) =>
        Effect.gen(function* createFromSource() {
          return yield* runHttp(
            createPartyWithAuthorization({ candidate: value }, yield* authorization(), yield* options),
          );
        });
      yield* Effect.logInfo('1316 stage source-create');
      const sourceCreateIdentity = yield* createPartyRequestIdentity(
        yield* Schema.encodeEffect(CreatePartyPayloadSchema)({ candidate: sourceCandidate }),
      );
      const originalCreateHash = computeActionRequestHash({ ...sourceCreateIdentity, principal });
      const beforeSource = yield* ownerSnapshot();
      const beforeSourceEvidence = yield* fixture.evidence(coreEvidenceExecutor);
      const [sourceCreated, sourceReplayed] = yield* Effect.all([createSource(), createSource()], { concurrency: 2 });
      assert.isOk(sourceCreated.outcome === 'CREATED');
      expect(sourceReplayed).toEqual(sourceCreated);
      const sourceReceipts = yield* admin
        .select()
        .from(partyCreateSourceReceipts)
        .where(eq(partyCreateSourceReceipts.matchDecisionId, sourceCreated.decisionRef.resourceId));
      expect(sourceReceipts).toHaveLength(2);
      const afterSource = yield* ownerSnapshot();
      const afterSourceEvidence = yield* fixture.evidence(coreEvidenceExecutor);
      for (const sourceReceipt of sourceReceipts) {
        expect(
          afterSourceEvidence.invocations.find(
            (invocation) => invocation.actionInvocationId === sourceReceipt.actionInvocationId,
          )?.requestHash,
        ).toBe(originalCreateHash);
      }

      expect(afterSource.parties).toHaveLength(beforeSource.parties.length + 1);
      expect(afterSource.decisions).toHaveLength(beforeSource.decisions.length + 1);
      expect(afterSourceEvidence.events).toHaveLength(beforeSourceEvidence.events.length + 1);
      expect(afterSourceEvidence.outbox).toHaveLength(beforeSourceEvidence.outbox.length + 1);
      expect(checkedTargets).toEqual([{ kind: 'PARTY', partyId: sourceCreated.partyRef.resourceId }]);

      const recoverSource = (invocationId: string) =>
        Effect.gen(function* recoverFromSource() {
          return yield* runHttp(
            recoverPartyCreateWithAuthorization(
              { invocationId: yield* Schema.decodeEffect(ActionInvocationIdSchema)(invocationId) },
              () =>
                Effect.gen(function* issueFreshSourceCredential() {
                  return {
                    credential: Redacted.make(yield* authorization()),
                    options: { baseUrl: new URL(baseUrl), compositionRevision: composition.composition.revision },
                  };
                }),
              { baseUrl, compositionRevision: composition.composition.revision, correlationId: yield* nextId },
            ),
          );
        });
      for (const { actionInvocationId } of sourceReceipts) {
        const result = yield* recoverSource(actionInvocationId);
        assert.isOk(Predicate.isTagged(result, 'PartyCreateRecovered'));
        expect(result.result).toEqual(sourceCreated);
      }
      expect(checkedTargets).toEqual(
        Array.from({ length: 3 }, () => ({ kind: 'PARTY', partyId: sourceCreated.partyRef.resourceId })),
      );
      yield* Effect.logInfo('1316 stage source-receipt');
      const sourceCreateReceipt = yield* runHttp(
        executePartySourceEffectReceiptWithAuthorization(
          { operation: 'CREATE', payload: { candidate: sourceCandidate } },
          yield* authorization(),
          yield* nextId,
          { baseUrl, compositionRevision: composition.composition.revision },
        ),
      );
      expect(sourceCreateReceipt).toMatchObject({ outcome: 'COMMITTED', operation: 'CREATE', result: sourceCreated });
      const missingSourceReceipt = yield* runHttp(
        executePartySourceEffectReceiptWithAuthorization(
          {
            operation: 'CREATE',
            payload: {
              candidate: {
                ...sourceCandidate,
                subjectEvidence: sourceCandidate.subjectEvidence.map((assertion) => ({
                  ...assertion,
                  occurrenceId: 'never-submitted',
                })),
              },
            },
          },
          yield* authorization(),
          yield* nextId,
          { baseUrl, compositionRevision: composition.composition.revision },
        ),
      );
      expect(missingSourceReceipt).toEqual({ outcome: 'INDETERMINATE' });
      const [receipt] = sourceReceipts;
      assert.isOk(receipt);
      const initialSourceInvocationId = yield* Schema.decodeEffect(ActionInvocationIdSchema)(
        receipt.actionInvocationId,
      );
      const sourceReadOptions = { baseUrl, compositionRevision: composition.composition.revision };
      const exactDecision = yield* runHttp(
        executePartyMatchDecisionWithAuthorization(
          { actionInvocationId: initialSourceInvocationId },
          yield* authorization(),
          yield* nextId,
          sourceReadOptions,
        ),
      );
      expect(exactDecision).toMatchObject({ evidenceEvaluation: null, evidenceExplanation: [] });
      expect(
        yield* runHttp(
          executePartyMatchDecisionWithAuthorization(
            { actionInvocationId: initialSourceInvocationId },
            yield* authorization(fixture.manager),
            yield* nextId,
            sourceReadOptions,
          ),
        ).pipe(Effect.flip),
      ).toMatchObject({ status: 503 });
      expect((yield* readDecision(sourceCreated.decisionRef)).evidenceEvaluation?.evidence[0]?.kind).toBe(
        'CLIENT_SOURCE_ASSERTION',
      );
      expect(
        yield* createSource({ ...sourceCandidate, businessName: 'Conflicting intent' }).pipe(Effect.flip),
      ).toMatchObject({ status: 409 });
      targetAllowed.PARTY = false;
      expect(yield* createSource().pipe(Effect.flip)).toMatchObject({ status: 403 });
      const nextOccurrence = {
        ...sourceCandidate,
        subjectEvidence: sourceCandidate.subjectEvidence.map((assertion) => ({
          ...assertion,
          occurrenceId: 'fixture-revision-2',
        })),
      };
      expect(yield* createSource(nextOccurrence).pipe(Effect.flip)).toMatchObject({ status: 403 });
      expect(
        yield* runHttp(
          matchPartyWithAuthorization({ candidate: nextOccurrence }, yield* authorization(), yield* options),
        ).pipe(Effect.flip),
      ).toMatchObject({ status: 403 });
      for (const { actionInvocationId } of sourceReceipts) {
        expect(yield* recoverSource(actionInvocationId).pipe(Effect.flip)).toMatchObject({ status: 503 });
      }
      expect(yield* ownerSnapshot()).toEqual(afterSource);
      targetAllowed.PARTY = true;
      fixture.faultNextTransaction('lost-ack');
      const lostAcknowledgement = yield* createSource().pipe(Effect.flip);
      assert.isOk(Predicate.isTagged(lostAcknowledgement, 'PartyCommandCommitIndeterminateProblem'));
      const recoveredLostAcknowledgement = yield* recoverSource(lostAcknowledgement.invocationId);
      assert.isOk(Predicate.isTagged(recoveredLostAcknowledgement, 'PartyCreateRecovered'));
      expect(recoveredLostAcknowledgement.result).toEqual(sourceCreated);
      expect(yield* ownerSnapshot()).toEqual(afterSource);
      const finalSourceEvidence = yield* fixture.evidence(coreEvidenceExecutor);
      expect(finalSourceEvidence.events).toEqual(afterSourceEvidence.events);
      expect(finalSourceEvidence.outbox).toEqual(afterSourceEvidence.outbox);

      // The same declared name is weak evidence, but a distinct record cannot inherit the first source correlation.
      const weakSourceCandidate = {
        ...sourceCandidate,
        subjectEvidence: sourceCandidate.subjectEvidence.map((assertion) => ({
          ...assertion,
          recordId: 'fixture-uncorrelated-record',
        })),
      };
      const matchWeakSource = Effect.gen(function* matchWeakSourceCandidate() {
        return yield* runHttp(
          matchPartyWithAuthorization({ candidate: weakSourceCandidate }, yield* authorization(), yield* options),
        );
      });
      targetAllowed.PARTY = false;
      expect(yield* createSource(weakSourceCandidate).pipe(Effect.flip)).toMatchObject({ status: 403 });
      expect(yield* ownerSnapshot()).toEqual(afterSource);
      targetAllowed.PARTY = true;
      targetAllowed.DUPLICATE_CANDIDATE = false;
      expect(yield* createSource(weakSourceCandidate).pipe(Effect.flip)).toMatchObject({ status: 403 });
      expect(yield* matchWeakSource.pipe(Effect.flip)).toMatchObject({ status: 403 });
      expect(yield* ownerSnapshot()).toEqual(afterSource);

      targetAllowed.DUPLICATE_CANDIDATE = true;
      yield* Effect.logInfo('1316 stage source-ambiguity');
      const ambiguousSource = yield* createSource(weakSourceCandidate);
      assert.isOk(ambiguousSource.outcome === 'AMBIGUOUS');
      const ambiguousMatch = yield* matchWeakSource;
      expect(ambiguousMatch).toMatchObject({
        candidateParties: [sourceCreated.partyRef],
        caseRef: ambiguousSource.caseRef,
        outcome: 'AMBIGUOUS',
      });
      const recoveredSourceMatch = yield* runHttp(
        executePartySourceEffectReceiptWithAuthorization(
          { operation: 'MATCH', payload: { candidate: weakSourceCandidate } },
          yield* authorization(),
          yield* nextId,
          sourceReadOptions,
        ),
      );
      expect(recoveredSourceMatch).toMatchObject({
        outcome: 'COMMITTED',
        operation: 'MATCH',
        result: ambiguousMatch,
      });
      const matchSourceReplay = yield* matchWeakSource;
      expect(matchSourceReplay).toEqual(ambiguousMatch);
      const afterAmbiguity = yield* ownerSnapshot();
      expect(afterAmbiguity.cases).toHaveLength(afterSource.cases.length + 1);
      expect(afterAmbiguity.parties).toEqual(afterSource.parties);
      const [ambiguityReceipt] = yield* admin
        .select()
        .from(partyCreateSourceReceipts)
        .where(eq(partyCreateSourceReceipts.matchDecisionId, ambiguousSource.decisionRef.resourceId));
      assert.isOk(ambiguityReceipt);
      const recoveredAmbiguity = yield* recoverSource(ambiguityReceipt.actionInvocationId);
      assert.isOk(Predicate.isTagged(recoveredAmbiguity, 'PartyCreateRecovered'));
      expect(recoveredAmbiguity.result).toEqual(ambiguousSource);
      targetAllowed.PARTY = false;
      expect(
        yield* runHttp(
          executeDuplicateCandidateDetailWithAuthorization(
            { caseRef: ambiguousSource.caseRef },
            yield* authorization(),
            yield* nextId,
            sourceReadOptions,
          ),
        ).pipe(Effect.flip),
      ).toMatchObject({ status: 503 });
      expect(
        yield* runHttp(
          executePartyMatchDecisionWithAuthorization(
            { decisionRef: ambiguousSource.decisionRef },
            yield* authorization(),
            yield* nextId,
            sourceReadOptions,
          ),
        ).pipe(Effect.flip),
      ).toMatchObject({ status: 503 });
      expect(yield* createSource(weakSourceCandidate).pipe(Effect.flip)).toMatchObject({ status: 403 });
      expect(yield* recoverSource(ambiguityReceipt.actionInvocationId).pipe(Effect.flip)).toMatchObject({
        status: 503,
      });
      targetAllowed.PARTY = true;
      targetAllowed.DUPLICATE_CANDIDATE = false;
      expect(yield* createSource(weakSourceCandidate).pipe(Effect.flip)).toMatchObject({ status: 403 });
      expect(yield* matchWeakSource.pipe(Effect.flip)).toMatchObject({ status: 403 });
      expect(
        yield* runHttp(
          matchPartyWithAuthorization(
            { candidate: weakSourceCandidate, priorCaseRef: ambiguousSource.caseRef },
            yield* authorization(),
            yield* options,
          ),
        ).pipe(Effect.flip),
      ).toMatchObject({ status: 403 });
      expect(yield* ownerSnapshot()).toEqual(afterAmbiguity);
      targetAllowed.DUPLICATE_CANDIDATE = true;

      // The existing owner review and evidence Read now reauthorize the source and exact target.
      yield* Effect.logInfo('1316 stage source-review');
      const sourceCase = yield* runHttp(
        executeDuplicateCandidateDetailWithAuthorization(
          { caseRef: ambiguousSource.caseRef },
          yield* authorization(),
          yield* nextId,
          sourceReadOptions,
        ),
      );
      expect(sourceCase.candidate.subjectEvidence?.[0]?.kind).toBe('CLIENT_SOURCE_ASSERTION');
      const sourceReview = yield* runHttp(
        resolveDuplicateCandidateMatchWithAuthorization(
          {
            caseRef: ambiguousSource.caseRef,
            selectedPartyRef: sourceCreated.partyRef,
            expectedRevision: sourceCase.revision,
            reason: 'Internal fixture reviews this exact source subject',
          },
          yield* authorization(),
          yield* options,
        ),
      );
      expect(sourceReview.partyRef).toEqual(sourceCreated.partyRef);
      targetAllowed.DUPLICATE_CANDIDATE = false;
      expect(
        yield* runHttp(
          executeDuplicateCandidateDetailWithAuthorization(
            { caseRef: ambiguousSource.caseRef },
            yield* authorization(),
            yield* nextId,
            sourceReadOptions,
          ),
        ).pipe(Effect.flip),
      ).toMatchObject({ status: 503 });
      targetAllowed.DUPLICATE_CANDIDATE = true;

      const [retainedSourceCase] = yield* admin
        .select()
        .from(duplicateCandidateCases)
        .where(eq(duplicateCandidateCases.candidateCaseId, ambiguousSource.caseRef.resourceId));
      assert.isOk(retainedSourceCase);
      yield* admin
        .update(duplicateCandidateCases)
        .set({ candidateSnapshot: { ...retainedSourceCase.candidateSnapshot, subjectEvidence: [] } })
        .where(eq(duplicateCandidateCases.candidateCaseId, ambiguousSource.caseRef.resourceId));
      expect(
        yield* runHttp(
          executeDuplicateCandidateDetailWithAuthorization(
            { caseRef: ambiguousSource.caseRef },
            yield* authorization(),
            yield* nextId,
            sourceReadOptions,
          ),
        ).pipe(Effect.flip),
      ).toMatchObject({ status: 503 });
      yield* admin
        .update(duplicateCandidateCases)
        .set({ candidateSnapshot: retainedSourceCase.candidateSnapshot })
        .where(eq(duplicateCandidateCases.candidateCaseId, ambiguousSource.caseRef.resourceId));

      yield* Effect.logInfo('1316 stage source-update');
      const updatePayload = {
        partyRef: sourceCreated.partyRef,
        expectedRevision: 1,
        businessName: 'Updated internal source organization',
        provenanceMethod: 'CLIENT_SOURCE_ASSERTION',
        provenanceSource: 'internal-contract-fixture',
        subjectEvidence: sourceCandidate.subjectEvidence.map((assertion) => ({
          ...assertion,
          occurrenceId: 'fixture-update-1',
        })),
        validFrom: DateTime.makeUnsafe('2021-01-01T00:00:00.000Z'),
      };
      const updateSource = (payload = updatePayload) =>
        Effect.gen(function* updateSourceParty() {
          return yield* runHttp(updatePartyWithAuthorization(payload, yield* authorization(), yield* options));
        });
      targetAllowed.PARTY = false;
      expect(yield* updateSource().pipe(Effect.flip)).toMatchObject({ status: 403 });
      targetAllowed.PARTY = true;
      const sourceUpdateIdentity = yield* updatePartyRequestIdentity(
        yield* Schema.encodeEffect(UpdatePartyPayloadSchema)(updatePayload),
      );
      const originalUpdateHash = computeActionRequestHash({ ...sourceUpdateIdentity, principal });
      const beforeUpdateEvidence = yield* fixture.evidence(coreEvidenceExecutor);
      const [sourceUpdated, updateReplay] = yield* Effect.all([updateSource(), updateSource()], { concurrency: 2 });
      expect(updateReplay).toEqual(sourceUpdated);
      expect(sourceUpdated.revision).toBe(2);
      const afterUpdateEvidence = yield* fixture.evidence(coreEvidenceExecutor);
      expect(afterUpdateEvidence.events).toHaveLength(beforeUpdateEvidence.events.length + 1);
      expect(afterUpdateEvidence.outbox).toHaveLength(beforeUpdateEvidence.outbox.length + 1);
      expect(
        yield* updateSource({ ...updatePayload, businessName: 'Conflicting source occurrence' }).pipe(Effect.flip),
      ).toMatchObject({ status: 409 });
      expect(
        yield* updateSource({
          ...updatePayload,
          subjectEvidence: updatePayload.subjectEvidence.map((assertion) => ({
            ...assertion,
            occurrenceId: 'fixture-stale-update',
          })),
        }).pipe(Effect.flip),
      ).toMatchObject({ status: 409 });
      const [updatedName] = yield* admin
        .select()
        .from(partyFactAssertions)
        .where(
          eq(
            partyFactAssertions.acceptedByActionInvocationId,
            (yield* admin
              .select()
              .from(partySourceEffectReceipts)
              .where(eq(partySourceEffectReceipts.partyId, sourceCreated.partyRef.resourceId)))[0]
              ?.actionInvocationId ?? '00000000-0000-4000-8000-000000000000',
          ),
        );
      assert.isOk(updatedName);
      yield* Effect.logInfo('1316 stage source-correction');
      const correctionPayload = {
        partyId: yield* Schema.decodeEffect(PartyIdSchema)(sourceCreated.partyRef.resourceId),
        factKind: 'BUSINESS_NAME' as const,
        targetAssertionId: yield* Schema.decodeEffect(TargetAssertionIdSchema)(updatedName.assertionId),
        replacementValue: 'Corrected internal source organization',
        evidenceRefs: ['internal-contract/source-correction'],
        evidenceSource: 'SYSTEM_RECONCILIATION' as const,
        policyVersion: 'party-correction.v1' as const,
        reasonCode: 'WRONG_IDENTITY_VALUE' as const,
        provenance: { method: 'CLIENT_SOURCE_ASSERTION', source: 'internal-contract-fixture' },
        subjectEvidence: sourceCandidate.subjectEvidence.map((assertion) => ({
          ...assertion,
          occurrenceId: 'fixture-correction-1',
        })),
      };
      const correctSource = (payload = correctionPayload) =>
        Effect.gen(function* correctSourceParty() {
          return yield* runHttp(correctPartyFactWithAuthorization(payload, yield* authorization(), yield* options));
        });
      const sourceCorrectionIdentity = yield* correctPartyFactRequestIdentity(
        yield* Schema.encodeEffect(CorrectPartyFactPayloadSchema)(correctionPayload),
      );
      const originalCorrectionHash = computeActionRequestHash({ ...sourceCorrectionIdentity, principal });
      const beforeCorrectionEvidence = yield* fixture.evidence(coreEvidenceExecutor);
      const [sourceCorrected, correctionReplay] = yield* Effect.all([correctSource(), correctSource()], {
        concurrency: 2,
      });
      expect(correctionReplay).toEqual(sourceCorrected);
      const afterCorrectionEvidence = yield* fixture.evidence(coreEvidenceExecutor);
      expect(afterCorrectionEvidence.events).toHaveLength(beforeCorrectionEvidence.events.length + 1);
      expect(afterCorrectionEvidence.outbox).toHaveLength(beforeCorrectionEvidence.outbox.length + 1);
      expect(
        yield* correctSource({ ...correctionPayload, replacementValue: 'Changed occurrence content' }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ status: 409 });
      expect(
        yield* correctSource({
          ...correctionPayload,
          subjectEvidence: correctionPayload.subjectEvidence.map((assertion) => ({
            ...assertion,
            occurrenceId: 'fixture-stale-correction',
          })),
        }).pipe(Effect.flip),
      ).toMatchObject({ status: 409 });
      const recoveredUpdate = yield* runHttp(
        executePartySourceEffectReceiptWithAuthorization(
          { operation: 'UPDATE', payload: updatePayload },
          yield* authorization(),
          yield* nextId,
          sourceReadOptions,
        ),
      );
      expect(recoveredUpdate).toMatchObject({
        outcome: 'COMMITTED',
        operation: 'UPDATE',
        result: { partyRef: sourceCreated.partyRef, revision: 2 },
      });
      if (recoveredUpdate.outcome === 'COMMITTED' && recoveredUpdate.operation === 'UPDATE') {
        expect(Object.keys(recoveredUpdate.result).toSorted()).toEqual(['partyRef', 'revision']);
      }
      // Later changes never cause an old source occurrence to re-export its former name.
      expect(yield* updateSource().pipe(Effect.flip)).toMatchObject({ status: 409 });
      const recoveredCorrection = yield* runHttp(
        executePartySourceEffectReceiptWithAuthorization(
          { operation: 'CORRECTION', payload: correctionPayload },
          yield* authorization(),
          yield* nextId,
          sourceReadOptions,
        ),
      );
      expect(recoveredCorrection).toMatchObject({
        outcome: 'COMMITTED',
        operation: 'CORRECTION',
        result: sourceCorrected,
      });
      const storedEffects = yield* admin
        .select()
        .from(partySourceEffectReceipts)
        .where(eq(partySourceEffectReceipts.partyId, sourceCreated.partyRef.resourceId));
      const storedUpdate = storedEffects.find((effect) => effect.operation === 'UPDATE');
      const storedCorrection = storedEffects.find((effect) => effect.operation === 'CORRECTION');
      expect(
        afterCorrectionEvidence.invocations.find(
          (invocation) => invocation.actionInvocationId === storedUpdate?.actionInvocationId,
        )?.requestHash,
      ).toBe(originalUpdateHash);
      expect(
        afterCorrectionEvidence.invocations.find(
          (invocation) => invocation.actionInvocationId === storedCorrection?.actionInvocationId,
        )?.requestHash,
      ).toBe(originalCorrectionHash);

      expect(storedUpdate?.result).toEqual({ partyRef: sourceCreated.partyRef, revision: 2 });
      targetAllowed.PARTY = false;
      expect(
        yield* runHttp(
          executePartySourceEffectReceiptWithAuthorization(
            { operation: 'UPDATE', payload: updatePayload },
            yield* authorization(),
            yield* nextId,
            sourceReadOptions,
          ),
        ).pipe(Effect.flip),
      ).toMatchObject({ status: 503 });
      expect(yield* updateSource().pipe(Effect.flip)).toMatchObject({ status: 403 });
      expect(yield* correctSource().pipe(Effect.flip)).toMatchObject({ status: 403 });
      targetAllowed.PARTY = true;
      expect(
        yield* admin
          .select()
          .from(partySourceEffectReceipts)
          .where(eq(partySourceEffectReceipts.partyId, sourceCreated.partyRef.resourceId)),
      ).toHaveLength(2);

      const matchedOnlyCandidate = {
        ...sourceCandidate,
        businessName: 'Only matched source subject',
        subjectEvidence: sourceCandidate.subjectEvidence.map((assertion) => ({
          ...assertion,
          recordId: 'match-before-create',
          occurrenceId: 'fixture-matched-1',
        })),
      };
      const matchedOnly = yield* runHttp(
        matchPartyWithAuthorization({ candidate: matchedOnlyCandidate }, yield* authorization(), yield* options),
      );
      expect(matchedOnly.outcome).toBe('NO_MATCH');
      expect(
        yield* createSource({
          ...matchedOnlyCandidate,
          businessName: 'Changed after Match under same occurrence',
        }).pipe(Effect.flip),
      ).toMatchObject({ status: 409 });

      yield* admin
        .update(partyMatchDecisions)
        .set({ evidenceEvaluation: null })
        .where(eq(partyMatchDecisions.matchDecisionId, sourceCreated.decisionRef.resourceId));
      expect(yield* readDecision(sourceCreated.decisionRef).pipe(Effect.flip)).toMatchObject({ status: 503 });
      expect(yield* recoverSource(initialSourceInvocationId).pipe(Effect.flip)).toMatchObject({ status: 503 });
    }),
  );
});
