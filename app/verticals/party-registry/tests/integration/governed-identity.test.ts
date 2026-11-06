import { PgClient } from '@effect/sql-pg';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import {
  CoreSearchProjectionStoreLive,
  CoreSearchQueryRuntimeLive,
  loadDatabaseIdentityConnections,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  ReadRuntime,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  resolveActionCommit,
  runAction,
} from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makePartyDeniedAccess } from '../support/live-access-authority.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';
import {
  addTestGatewayScopeGrantCleanup,
  registerTestGatewayScopeGrant,
} from '@app/core-runtime/testing/gateway-scope-grant';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Crypto, Effect, Exit, Layer, Option, Redacted, Predicate, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { testCoreDatabase, deleteTestCoreOutbox } from '@app/core-runtime/testing/owner-evidence';
import { PartyCorrectionResponseSchema } from '../../shared/apis/party-correction.ts';
import { PartyCorrectionGovernance } from '../../shared/domain/correction-contracts.ts';
import type { PartyCandidateSchema } from '../../shared/domain/identity-contracts.ts';
import { committedCreateResult } from '../../shared/domain/matching-contracts.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { archivePartyAction } from '../../src/actions/archive-party.action.ts';
import { counterpartyCreateAction } from '../../src/actions/counterparty-create.action.ts';
import { counterpartyRoleAddAction } from '../../src/actions/counterparty-role-add.action.ts';
import { counterpartyRoleEndAction } from '../../src/actions/counterparty-role-end.action.ts';
import { createPartyRelationshipAction } from '../../src/actions/create-party-relationship.action.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { correctPartyFactAction } from '../../src/actions/correct-party-fact.action.ts';
import { endPartyRelationshipAction } from '../../src/actions/end-party-relationship.action.ts';
import { resolveDuplicateCandidateMatchAction } from '../../src/actions/resolve-duplicate-candidate-match.action.ts';
import { resolveDuplicateCandidateCreateAction } from '../../src/actions/resolve-duplicate-candidate-create.action.ts';
import { unarchivePartyAction } from '../../src/actions/unarchive-party.action.ts';
import { updatePartyAction } from '../../src/actions/update-party.action.ts';
import { updatePartyRelationshipAction } from '../../src/actions/update-party-relationship.action.ts';
import { counterpartyReadRead } from '../../src/api/counterparty-read.read.ts';
import { partyCorrectionRead } from '../../src/api/party-correction.read.ts';
import { partyDetailRead } from '../../src/api/party-detail.read.ts';
import { partyMatchDecisionRead } from '../../src/api/party-match-decision.read.ts';
import {
  duplicateCandidateCases,
  parties,
  partyFactAssertions,
  partyMatchDecisions,
  partyOfficialIdentifiers,
  partyRelations,
} from '../../src/db/schema.ts';
import { partiesRead, PartySearchProjectionGatewayLive } from '../../src/search/parties.provider.ts';
import { partyCompositionSnapshot } from './application-composition.setup.ts';

type EncodedPartyCandidate = typeof PartyCandidateSchema.Encoded;
const testAuthenticationNamespaceId = 'test.party.better-auth.v1';
const candidate = (ico: string, extra: Partial<EncodedPartyCandidate> = {}): EncodedPartyCandidate => ({
  partyType: 'ORGANIZATION',
  officialIdentifiers: [{ identifierType: 'ICO', value: ico }],
  subjectEvidence: [
    {
      kind: 'ACTOR_ATTESTATION',
      basis: 'REVIEWED_DOCUMENT',
      evidenceRef: 'review/42',
      observedSubject: 'ORGANIZATION',
      subjectKey: 'subject',
      statement: 'Reviewed this concrete external organization',
    },
  ],
  evidenceRefs: ['review/42'],
  provenance: { method: 'DOCUMENT', source: 'live-acceptance' },
  validFrom: '2020-01-01T00:00:00.000Z',
  ...extra,
});
const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const transport = (idempotencyKey: string) => ({
  correlationId: `live-${idempotencyKey}`,
  idempotencyKey,
  targetModuleKey: 'party.registry',
});
const freshTransport = nextUuid.pipe(Effect.map((idempotencyKey) => transport(idempotencyKey)));
const freshReadTransport = nextUuid.pipe(Effect.map((correlationId) => ({ correlationId })));
const readPartyDetail = (partyRef: PartyRef, principal: TrustedPrincipalContext, includeFactHistory = false) =>
  Effect.all([ReadRuntime, freshReadTransport]).pipe(
    Effect.flatMap(([runtime, readTransport]) =>
      runtime.runRead({
        registration: partyDetailRead,
        input: { partyRef, includeFactHistory },
        principal,
        transport: readTransport,
      }),
    ),
  );
type EncodedFixturePrincipal = typeof TrustedPrincipalContextSchema.Encoded;
const decodeFixturePrincipal = (principal: EncodedFixturePrincipal): TrustedPrincipalContext =>
  Schema.decodeSync(TrustedPrincipalContextSchema)(principal);

/** One name a detail carries, or null when it has none or the identity field group withheld it. */
const nameOf = (
  detail: {
    readonly party: Partial<Record<'businessName' | 'displayName' | 'firstName' | 'lastName', Option.Option<string>>>;
  },
  name: 'businessName' | 'displayName' | 'firstName' | 'lastName',
) => Option.getOrNull(detail.party[name] ?? Option.none());
const displayNameOf = (detail: Parameters<typeof nameOf>[0]) => nameOf(detail, 'displayName');
/** The fact history a detail carries; absent when not requested or withheld. */
const historyOf = <Fact>(detail: { readonly factHistory?: readonly Fact[] }): readonly Fact[] =>
  detail.factHistory ?? [];
/** The assertion a correction resulted in, or null when the response carries none. */
const resultingOf = <Fact>(detail: { readonly resultingAssertion?: Option.Option<Fact> }) =>
  Option.getOrNull(detail.resultingAssertion ?? Option.none());

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'governed Party identity uses real PostgreSQL and SpiceDB for explicit identity review, recovery and temporal authorization',
    () =>
      Effect.scoped(
        Effect.gen(function* governedIdentityTestEffect() {
          const connections = yield* loadDatabaseIdentityConnections({ envPath: '/dev/null' });
          const partyRuntimeConnectionString = connections.runtime[PARTY_REGISTRY_REQUEST_IDENTITY.id].connectionString;
          const issuerClient = yield* makeTestPgClient(
            connections.runtime[SHELL_GATEWAY_ISSUER_IDENTITY.id].connectionString,
            { maxConnections: 1 },
          );
          const compositionSnapshot = yield* partyCompositionSnapshot;
          const actionKeys = [
            createPartyAction,
            counterpartyCreateAction,
            counterpartyRoleAddAction,
            counterpartyRoleEndAction,
            resolveDuplicateCandidateCreateAction,
            resolveDuplicateCandidateMatchAction,
            createPartyRelationshipAction,
            updatePartyRelationshipAction,
            endPartyRelationshipAction,
            archivePartyAction,
            unarchivePartyAction,
            updatePartyAction,
            correctPartyFactAction,
          ].map(({ descriptor }) => descriptor.actionKey);
          const fixture = yield* Effect.acquireRelease(
            makeLiveOperationFixture({
              access: 'allowed',
              actionKeys,
              adminConnectionString: Redacted.make(connections.admin.connectionString),
              authenticationNamespaceId: testAuthenticationNamespaceId,
              compositionRevision: compositionSnapshot.composition.revision,
              ownerRegistration: partyRegistryBackendRegistration,
              runtimeConnectionString: Redacted.make(partyRuntimeConnectionString),
            }).pipe(Effect.orDie),
            (resource) => resource.close().pipe(Effect.orDie),
          );
          const other = yield* Effect.acquireRelease(
            makeLiveOperationFixture({
              access: 'allowed',
              actionKeys,
              adminConnectionString: Redacted.make(connections.admin.connectionString),
              authenticationNamespaceId: testAuthenticationNamespaceId,
              compositionRevision: compositionSnapshot.composition.revision,
              ownerRegistration: partyRegistryBackendRegistration,
              runtimeConnectionString: Redacted.make(partyRuntimeConnectionString),
            }).pipe(Effect.orDie),
            (resource) => resource.close().pipe(Effect.orDie),
          );
          const adminClient = yield* makeTestPgClient(connections.admin.connectionString);
          const admin = yield* makeTestDatabaseFromClient(adminClient, partyRelations);
          const coreAdmin = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, adminClient));
          // Release only these disposable tenants' dispatch queues; retain append-only Core evidence.
          yield* Effect.addFinalizer(() =>
            Effect.forEach([fixture.tenantId, other.tenantId], (tenantId) =>
              deleteTestCoreOutbox(adminClient, tenantId),
            ).pipe(Effect.orDie),
          );
          yield* addTestGatewayScopeGrantCleanup(adminClient, [fixture.tenantId, other.tenantId]);
          const deniedAccess = makePartyDeniedAccess();
          const fixtureContext = yield* Layer.build(fixture.layer.pipe(Layer.provide(deniedAccess.layer)));
          const otherContext = yield* Layer.build(other.layer);
          // Each principal carries a registered gateway grant for its own tenant and Legal Entity, as a
          // redeemed Shell assertion would.
          const withGatewayScope = Effect.fn('GovernedIdentityTest.withGatewayScope')(function* withGatewayScope(
            principal: EncodedFixturePrincipal,
          ) {
            const context = decodeFixturePrincipal(principal);
            const grant = {
              audience: 'party-registry',
              principalId: context.principalId,
              tenantId: context.tenantId,
            };
            const { assertion } = yield* registerTestGatewayScopeGrant(
              issuerClient,
              context.legalEntityId === undefined ? grant : { ...grant, legalEntityId: context.legalEntityId },
            ).pipe(Effect.orDie);
            return trustVerifiedGatewayPrincipalContext(context, compositionSnapshot.composition.revision, {
              assertion,
              audience: 'party-registry',
            });
          });
          const managerPrincipal = yield* withGatewayScope(fixture.manager);
          const deniedPrincipal = yield* withGatewayScope(fixture.denied);
          const legalEntityOnlyPrincipal = yield* withGatewayScope(fixture.legalEntityOnly);
          // v2: the one access gate decides every protected Action and Read (O62). The fixture
          // scripts its gate per capability, so the principals it does not admit are refused on the
          // fixture's own per-request owner seam (the removed SpiceDB executor/module tuples no
          // longer refuse anyone). The company-only actor keeps its counterparty authority.
          deniedAccess.deny(deniedPrincipal.principalId, 'party.registry.party.read');
          deniedAccess.deny(legalEntityOnlyPrincipal.principalId, 'party.registry.party.create');
          deniedAccess.deny(legalEntityOnlyPrincipal.principalId, 'party.registry.party.read');
          deniedAccess.deny(legalEntityOnlyPrincipal.principalId, 'party.registry.party.search');
          const managerReadPrincipal = yield* withGatewayScope({
            ...fixture.manager,
            legalEntityId: fixture.legalEntityId,
          });
          const otherManagerPrincipal = yield* withGatewayScope(other.manager);
          const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof fixture.layer> | Crypto.Crypto>) =>
            effect.pipe(Effect.provideContext(fixtureContext));
          const create = (
            value: EncodedPartyCandidate,
            idempotencyKey?: string,
            principal: TrustedPrincipalContext = managerPrincipal,
          ) =>
            Effect.gen(function* createParty() {
              return yield* runAction({
                registration: createPartyAction,
                payload: { candidate: value },
                principal,
                transport: transport(idempotencyKey ?? (yield* nextUuid)),
              });
            });
          const snapshot = Effect.fn('GovernedIdentityTest.snapshot')(function* snapshotEffect() {
            const [partyRows, assertions, decisions, cases, core] = yield* Effect.all(
              [
                admin.select().from(parties).where(eq(parties.tenantId, fixture.tenantId)).orderBy(parties.partyId),
                admin
                  .select()
                  .from(partyFactAssertions)
                  .where(eq(partyFactAssertions.tenantId, fixture.tenantId))
                  .orderBy(partyFactAssertions.assertionId),
                admin
                  .select()
                  .from(partyMatchDecisions)
                  .where(eq(partyMatchDecisions.tenantId, fixture.tenantId))
                  .orderBy(partyMatchDecisions.matchDecisionId),
                admin
                  .select()
                  .from(duplicateCandidateCases)
                  .where(eq(duplicateCandidateCases.tenantId, fixture.tenantId))
                  .orderBy(duplicateCandidateCases.candidateCaseId),
                fixture.evidence(coreAdmin),
              ],
              { concurrency: 6 },
            );
            return {
              partyRows,
              assertions,
              decisions,
              cases,
              core: {
                ...core,
                audits: core.audits.toSorted((left, right) => left.auditEventId.localeCompare(right.auditEventId)),
                events: core.events.toSorted((left, right) => left.domainEventId.localeCompare(right.domainEventId)),
                outbox: core.outbox.toSorted((left, right) =>
                  left.outboxMessageId.localeCompare(right.outboxMessageId),
                ),
              },
            };
          });
          const createIndependent = (value: EncodedPartyCandidate, principal = managerPrincipal) =>
            create(value, undefined, principal).pipe(
              Effect.tap((result) => Effect.sync(() => assert.isOk(result.outcome === 'CREATED'))),
            );
          const exact = candidate('27074358');
          const created = yield* run(create(exact));
          assert.isOk(created.outcome === 'CREATED');
          const { partyRef } = created;
          // Independent invocations after a matching declaration serialize to one review case.
          const concurrent = yield* Effect.all([run(create(exact)), run(create(exact))], { concurrency: 2 });
          const [first, secondResult] = concurrent;
          assert.isOk(first?.outcome === 'AMBIGUOUS' && secondResult?.outcome === 'AMBIGUOUS');
          expect(first.caseRef).toEqual(secondResult.caseRef);
          let state = yield* snapshot();
          expect(state.partyRows.length).toBe(1);
          expect(state.decisions.length).toBe(3);
          expect(state.assertions.length).toBe(1);
          expect(state.core.events.length).toBe(1);
          expect(state.core.outbox.length).toBe(1);
          expect(state.core.audits.length).toBe(3);
          assert.isOk(state.core.invocations.every((invocation) => invocation.status === 'succeeded'));
          assert.isOk(state.assertions[0]?.evidenceEvaluation?.subjectEligible);

          const attachment = yield* run(
            create(
              candidate('27074358', {
                officialIdentifiers: [...exact.officialIdentifiers, { identifierType: 'CZ_DIC', value: 'CZ27074358' }],
              }),
            ),
          );
          assert.isOk(attachment.outcome === 'AMBIGUOUS');
          const attached = yield* run(
            runAction({
              registration: resolveDuplicateCandidateMatchAction,
              payload: {
                caseRef: attachment.caseRef,
                expectedRevision: 1,
                selectedPartyRef: partyRef,
                reason: 'Reviewed exact subject before attaching declared identifier',
              },
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }),
          );
          expect(attached.outcome).toBe('MATCH_EXISTING');
          state = yield* snapshot();
          expect(state.partyRows.length).toBe(1);
          expect(state.core.events.length).toBe(2);
          expect(state.core.outbox.length).toBe(2);

          // Establish a concrete accepted review for the unchanged original candidate.
          const exactOpened = yield* run(create(exact));
          assert.isOk(exactOpened.outcome === 'AMBIGUOUS');
          yield* run(
            runAction({
              registration: resolveDuplicateCandidateMatchAction,
              payload: {
                caseRef: exactOpened.caseRef,
                expectedRevision: 1,
                selectedPartyRef: partyRef,
                reason: 'Reviewed original candidate against the canonical subject',
              },
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }),
          );
          const second = yield* run(
            createIndependent(
              candidate('26168685', {
                firstName: 'Source',
                lastName: 'Person',
                businessName: 'Source company',
              }),
            ),
          );
          expect(second.outcome).toBe('CREATED');
          assert.isOk(second.outcome === 'CREATED');
          const createdNames = yield* run(readPartyDetail(second.partyRef, managerReadPrincipal));
          expect(nameOf(createdNames, 'firstName')).toBe('Source');
          expect(nameOf(createdNames, 'lastName')).toBe('Person');
          expect(nameOf(createdNames, 'businessName')).toBe('Source company');
          expect(displayNameOf(createdNames)).toBe('Source company');
          const split = candidate('26168685', {
            firstName: 'Candidate',
            lastName: 'Person',
            businessName: 'Ambiguous source company',
            officialIdentifiers: [
              {
                identifierType: 'ICO',
                value: '26168685',
              },
              {
                identifierType: 'CZ_DIC',
                value: 'CZ27074358',
              },
            ],
          });
          const beforeSplit = yield* snapshot();
          const ambiguity = yield* run(create(split));
          const repeated = yield* run(create(split));
          assert.isOk(ambiguity.outcome === 'AMBIGUOUS' && repeated.outcome === 'AMBIGUOUS');

          expect(repeated.caseRef).toEqual(ambiguity.caseRef);
          state = yield* snapshot();
          expect(state.partyRows.length).toBe(2);
          expect(state.cases.length).toBe(beforeSplit.cases.length + 1);
          expect(state.decisions.filter((decision) => decision.committedCreateOutcome === 'AMBIGUOUS').length).toBe(
            beforeSplit.decisions.filter((decision) => decision.committedCreateOutcome === 'AMBIGUOUS').length + 2,
          );

          // Every Create outcome survives actual lost commit acknowledgement, followed by a new governed Read.
          const pendingRecoveryCreate = yield* run(
            create(candidate('27074358', { businessName: 'Reviewed recoverable subject' })),
          );
          assert.isOk(pendingRecoveryCreate.outcome === 'AMBIGUOUS');
          const recoveryOperations = [
            (key: string) =>
              runAction({
                registration: resolveDuplicateCandidateCreateAction,
                payload: {
                  caseRef: pendingRecoveryCreate.caseRef,
                  expectedRevision: 1,
                  reason: 'Reviewed recoverable Create',
                },
                principal: managerPrincipal,
                transport: transport(key),
              }).pipe(Effect.asVoid),
            (key: string) => create(candidate('45274649'), key).pipe(Effect.asVoid),
            (key: string) => create(exact, key).pipe(Effect.asVoid),
            (key: string) => create(split, key).pipe(Effect.asVoid),
          ];
          yield* Effect.forEach(
            recoveryOperations,
            Effect.fn('GovernedIdentityTest.verifyCommitRecovery')(function* verifyCommitRecoveryEffect(invoke) {
              const key = yield* nextUuid;
              fixture.faultNextTransaction('lost-ack');
              assert.isOk(Predicate.isTagged(yield* run(invoke(key).pipe(Effect.flip)), 'ActionCommitIndeterminate'));

              const before = yield* snapshot();
              const invocation = before.core.invocations.find((row) => row.idempotencyKey === key);
              assert.isOk(invocation);

              assert.isOk(
                Predicate.isTagged(
                  yield* run(
                    resolveActionCommit({
                      invocationId: invocation.actionInvocationId,
                      principal: managerPrincipal,
                    }).pipe(Effect.flip),
                  ),
                  'ActionAlreadyCommitted',
                ),
              );

              const recovered = yield* run(
                Effect.all([ReadRuntime, freshReadTransport]).pipe(
                  Effect.flatMap(([runtime, readTransport]) =>
                    runtime.runRead({
                      registration: partyMatchDecisionRead,
                      input: {
                        actionInvocationId: invocation.actionInvocationId,
                      },
                      principal: managerReadPrincipal,
                      transport: readTransport,
                    }),
                  ),
                ),
              );
              const original = before.decisions.find((row) => row.actionInvocationId === invocation.actionInvocationId);
              assert.isOk(original);

              const recoveredResult = committedCreateResult(recovered);
              assert.isOk(recoveredResult);

              expect(recoveredResult.outcome).toBe(original.committedCreateOutcome);
              expect(recoveredResult.decisionRef.resourceId).toBe(original.matchDecisionId);
              expect(recovered.partyRef?.resourceId ?? null).toBe(original.partyId);
              expect(recovered.caseRef?.resourceId ?? null).toBe(original.candidateCaseId);
              assert.isOk(Predicate.isTagged(yield* run(invoke(key).pipe(Effect.flip)), 'ActionAlreadyCommitted'));

              const after = yield* snapshot();
              expect(after.partyRows).toEqual(before.partyRows);
              expect(after.decisions).toEqual(before.decisions);
              expect(after.core.events).toEqual(before.core.events);
              expect(after.core.outbox).toEqual(before.core.outbox);
              assert.isOk(
                Predicate.isTagged(
                  yield* run(readPartyDetail(partyRef, deniedPrincipal).pipe(Effect.flip)),
                  'ReadPermissionDenied',
                ),
              );
            }),
            { concurrency: 1, discard: true },
          );
          const beforeDenied = yield* snapshot();
          assert.isOk(
            Predicate.isTagged(
              yield* run(create(candidate('00006947', { subjectEvidence: [] })).pipe(Effect.flip)),
              'PartyEvidenceInsufficient',
            ),
          );

          const afterDenied = yield* snapshot();
          expect(afterDenied.partyRows).toEqual(beforeDenied.partyRows);
          expect(afterDenied.decisions).toEqual(beforeDenied.decisions);
          expect(afterDenied.cases).toEqual(beforeDenied.cases);
          fixture.faultNextTransaction('rollback');
          yield* run(create(candidate('00006947')).pipe(Effect.flip));
          const rolledBack = yield* snapshot();
          expect(rolledBack.partyRows).toEqual(beforeDenied.partyRows);
          expect(rolledBack.assertions).toEqual(beforeDenied.assertions);
          expect(rolledBack.cases).toEqual(beforeDenied.cases);
          expect(rolledBack.core.audits).toEqual(beforeDenied.core.audits);
          expect(rolledBack.decisions).toEqual(beforeDenied.decisions);
          expect(rolledBack.core.events).toEqual(beforeDenied.core.events);
          expect(rolledBack.core.outbox).toEqual(beforeDenied.core.outbox);

          const independent = yield* createIndependent(exact, otherManagerPrincipal).pipe(
            Effect.provideContext(otherContext),
          );

          assert.isOk(independent.outcome === 'CREATED');
          expect(independent.partyRef.resourceId).not.toBe(partyRef.resourceId);
          assert.isOk(
            Predicate.isTagged(
              yield* run(readPartyDetail(independent.partyRef, managerReadPrincipal).pipe(Effect.flip)),
              'ReadHandlerNotFound',
            ),
          );

          assert.isOk(
            Predicate.isTagged(
              yield* run(create(candidate('00006947'), yield* nextUuid, legalEntityOnlyPrincipal).pipe(Effect.flip)),
              'ActionPermissionDenied',
            ),
          );

          assert.isOk(
            Predicate.isTagged(
              yield* run(readPartyDetail(partyRef, legalEntityOnlyPrincipal).pipe(Effect.flip)),
              'ReadPermissionDenied',
            ),
          );

          const searchLayer = PartySearchProjectionGatewayLive.pipe(
            Layer.provide(CoreSearchQueryRuntimeLive),
            Layer.provide(CoreSearchProjectionStoreLive),
          );
          const searchContext = yield* Layer.build(searchLayer).pipe(Effect.provideContext(fixtureContext));
          const deniedSearch = Effect.all([ReadRuntime, freshReadTransport]).pipe(
            Effect.flatMap(([runtime, readTransport]) =>
              runtime.runRead({
                registration: partiesRead,
                input: { query: 'Live' },
                principal: legalEntityOnlyPrincipal,
                transport: readTransport,
              }),
            ),
            Effect.provideContext(searchContext),
          );
          assert.isOk(Predicate.isTagged(yield* run(deniedSearch.pipe(Effect.flip)), 'ReadPermissionDenied'));

          assert.isOk(
            Predicate.isTagged(
              yield* run(
                Effect.all([ReadRuntime, freshReadTransport]).pipe(
                  Effect.flatMap(([runtime, readTransport]) =>
                    runtime.runRead({
                      registration: partyMatchDecisionRead,
                      input: { decisionRef: independent.decisionRef },
                      principal: managerReadPrincipal,
                      transport: readTransport,
                    }),
                  ),
                  Effect.flip,
                ),
              ),
              'ReadHandlerNotFound',
            ),
          );

          const provenance = {
            evidenceReference: 'review/42',
            method: 'SIGNED_CONTRACT',
            source: 'live-acceptance',
            reason: 'Business relationship',
          };
          const counterparty = () =>
            freshTransport.pipe(
              Effect.flatMap((commandTransport) =>
                runAction({
                  registration: counterpartyCreateAction,
                  payload: { partyRef, provenance },
                  principal: legalEntityOnlyPrincipal,
                  transport: commandTransport,
                }),
              ),
            );
          const counterparties = yield* Effect.all([run(counterparty()), run(counterparty())], {
            concurrency: 2,
          });
          expect(counterparties.map((item) => item.created).toSorted()).toEqual([false, true]);
          expect(counterparties[0]?.counterpartyRef).toEqual(counterparties[1]?.counterpartyRef);
          const counterpartyRef = counterparties[0]?.counterpartyRef;
          assert.isOk(counterpartyRef);

          const readCounterparty = () =>
            run(
              Effect.all([ReadRuntime, freshReadTransport]).pipe(
                Effect.flatMap(([runtime, readTransport]) =>
                  runtime.runRead({
                    registration: counterpartyReadRead,
                    input: { counterpartyRef },
                    principal: legalEntityOnlyPrincipal,
                    transport: readTransport,
                  }),
                ),
              ),
            );
          // Owning a business Counterparty does not itself grant resource permission (O67-Q1): the
          // owner seam refuses the record-scoped read until the counterparty grant is made.
          deniedAccess.deny(legalEntityOnlyPrincipal.principalId, 'party.registry.counterparty.read');
          const forbiddenCounterpartyRead = yield* Effect.exit(readCounterparty());
          assert.isOk(Exit.isFailure(forbiddenCounterpartyRead));

          yield* fixture.grantResourceAccess(counterpartyRef, legalEntityOnlyPrincipal.principalId);
          deniedAccess.allow(legalEntityOnlyPrincipal.principalId, 'party.registry.counterparty.read');
          const projection = yield* readCounterparty();
          expect(Object.keys(projection.party).toSorted()).toEqual([
            'archived',
            'canonicalPartyRef',
            'displayName',
            'partyType',
            'storedPartyRef',
          ]);
          yield* run(
            runAction({
              registration: counterpartyCreateAction,
              payload: { partyRef, provenance },
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }).pipe(Effect.flip),
          );
          yield* fixture.grantResourceAccess(counterpartyRef, legalEntityOnlyPrincipal.principalId, 'writer');
          const role = (roleType: 'CUSTOMER' | 'SUPPLIER') =>
            run(
              freshTransport.pipe(
                Effect.flatMap((commandTransport) =>
                  runAction({
                    registration: counterpartyRoleAddAction,
                    payload: {
                      counterpartyRef,
                      roleType,
                      provenance,
                      validFrom: '2020-01-01T00:00:00.000Z',
                    },
                    principal: legalEntityOnlyPrincipal,
                    transport: commandTransport,
                  }),
                ),
              ),
            );
          const customer = yield* role('CUSTOMER');
          yield* role('SUPPLIER');
          yield* run(
            runAction({
              registration: counterpartyRoleEndAction,
              payload: {
                counterpartyRef,
                rolePeriodRef: customer.rolePeriodRef,
                provenance: {
                  ...provenance,
                  method: 'SIGNED_TERMINATION_AGREEMENT',
                },
                validTo: '2021-01-01T00:00:00.000Z',
              },
              principal: legalEntityOnlyPrincipal,
              transport: yield* freshTransport,
            }),
          );
          const counterpartyAfterRoleEnd = yield* readCounterparty();
          expect(counterpartyAfterRoleEnd.currentRoles.map((item) => item.roleType)).toEqual(['SUPPLIER']);

          const person = yield* run(
            create(
              candidate('00006947', {
                partyType: 'PERSON',
                officialIdentifiers: [],
                firstName: 'Live contact',
                subjectEvidence: [
                  {
                    kind: 'ACTOR_ATTESTATION',
                    basis: 'DIRECT_INTERACTION',
                    evidenceRef: 'meeting/42',
                    subjectKey: 'person',
                    observedSubject: 'PERSON',
                    statement: 'Met this concrete external person',
                  },
                ],
              }),
            ),
          );
          assert.isOk(person.outcome === 'CREATED');
          const restoredNames = yield* run(readPartyDetail(person.partyRef, managerReadPrincipal));
          expect(nameOf(restoredNames, 'firstName')).toBe('Live contact');
          expect(nameOf(restoredNames, 'lastName')).toBe(null);
          expect(nameOf(restoredNames, 'businessName')).toBe(null);
          expect(displayNameOf(restoredNames)).toBe('Live contact');

          const relationship = yield* run(
            runAction({
              registration: createPartyRelationshipAction,
              payload: {
                fromPartyRef: person.partyRef,
                toPartyRef: partyRef,
                relationshipType: 'CONTACT_PERSON_OF',
                validFrom: '2090-01-01T00:00:00.000Z',
                validTo: null,
                provenance: { method: 'DIRECT_INTERACTION', source: 'live' },
              },
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }),
          );
          // Domain relationships never provision access to Party records.
          assert.isOk(
            Predicate.isTagged(
              yield* run(readPartyDetail(person.partyRef, legalEntityOnlyPrincipal).pipe(Effect.flip)),
              'ReadPermissionDenied',
            ),
          );

          assert.isOk(
            Predicate.isTagged(
              yield* run(readPartyDetail(partyRef, legalEntityOnlyPrincipal).pipe(Effect.flip)),
              'ReadPermissionDenied',
            ),
          );

          const updatedRelationship = yield* run(
            runAction({
              registration: updatePartyRelationshipAction,
              payload: {
                relationshipRef: relationship.relationship.relationshipRef,
                expectedRevision: relationship.relationship.revision,
                changeReason: 'Change planned start',
                validFrom: '2089-01-01T00:00:00.000Z',
                provenance: { method: 'DOCUMENT', source: 'live' },
              },
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }),
          );
          expect(updatedRelationship.outcome).toBe('CHANGED');
          const endedRelationship = yield* run(
            runAction({
              registration: endPartyRelationshipAction,
              payload: {
                relationshipRef: relationship.relationship.relationshipRef,
                expectedRevision: updatedRelationship.relationship.revision,
                effectiveAt: '2091-01-01T00:00:00.000Z',
                reason: 'Contact ended',
                provenance: { method: 'DOCUMENT', source: 'live' },
              },
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }),
          );
          expect(endedRelationship.outcome).toBe('CHANGED');

          // Equal declared identifiers may belong to separate reviewed subjects. They are not identity claims.
          // Preserve the archive/unarchive path without fabricating a cross-Party exclusive conflict.
          const legacy = yield* run(createIndependent(candidate('00006947')));

          assert.isOk(legacy.outcome === 'CREATED');
          const legacyArchived = yield* run(
            runAction({
              registration: archivePartyAction,
              payload: {
                partyRef: legacy.partyRef,
                expectedRevision: 1,
                reason: 'Historical collision fixture',
              },
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }),
          );
          const [identifierTemplate] = yield* admin
            .select()
            .from(partyOfficialIdentifiers)
            .where(
              and(
                eq(partyOfficialIdentifiers.tenantId, fixture.tenantId),
                eq(partyOfficialIdentifiers.partyId, partyRef.resourceId),
              ),
            )
            .limit(1);
          assert.isOk(identifierTemplate);

          yield* admin.insert(partyOfficialIdentifiers).values({
            ...identifierTemplate,
            officialIdentifierId: yield* nextUuid,
            partyId: legacy.partyRef.resourceId,
          });
          const collision = yield* run(
            runAction({
              registration: unarchivePartyAction,
              payload: {
                partyRef: legacy.partyRef,
                expectedRevision: legacyArchived.revision,
                reason: 'Recheck independent declared facts',
              },
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }),
          );
          expect(collision.outcome).toBe('UNARCHIVED');
          const independentAfterUnarchive = yield* run(readPartyDetail(legacy.partyRef, managerReadPrincipal));
          expect(independentAfterUnarchive.party.partyRef).toEqual(legacy.partyRef);
          expect(independentAfterUnarchive.party.partyRef).not.toEqual(partyRef);

          const current = yield* run(readPartyDetail(partyRef, managerReadPrincipal));
          const archived = yield* run(
            runAction({
              registration: archivePartyAction,
              payload: {
                partyRef,
                expectedRevision: current.party.revision,
                reason: 'Archive acceptance',
              },
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }),
          );
          const archivedParty = yield* run(readPartyDetail(partyRef, managerReadPrincipal));
          assert.isOk(archivedParty.party.archivedAt);

          const archivedCounterparty = yield* readCounterparty();
          expect(archivedCounterparty.party.archived).toBe(true);
          yield* run(counterparty().pipe(Effect.flip));
          const unarchive = yield* run(
            runAction({
              registration: unarchivePartyAction,
              payload: {
                partyRef,
                expectedRevision: archived.revision,
                reason: 'Unarchive acceptance',
              },
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }),
          );
          expect(unarchive.outcome).toBe('BLOCKED');
          assert.isOk(unarchive.outcome === 'BLOCKED' && unarchive.reasonCode === 'OPEN_DUPLICATE_CASE');

          // Structured sources round-trip through the existing public write/read lifecycles.
          assert.isOk(second.outcome === 'CREATED');
          const beforeNames = yield* run(readPartyDetail(second.partyRef, managerReadPrincipal));
          const named = yield* run(
            runAction({
              registration: updatePartyAction,
              payload: {
                partyRef: second.partyRef,
                expectedRevision: beforeNames.party.revision,
                firstName: 'Ada',
                lastName: 'Byron',
                businessName: 'Analytical Engines',
                provenanceMethod: 'DOCUMENT',
                provenanceSource: 'live-acceptance',
                validFrom: '2021-01-01T00:00:00.000Z',
              },
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }),
          );
          expect(Option.getOrNull(named.firstName)).toBe('Ada');
          expect(Option.getOrNull(named.lastName)).toBe('Byron');
          expect(Option.getOrNull(named.businessName)).toBe('Analytical Engines');
          expect(Option.getOrNull(named.displayName)).toBe('Analytical Engines');
          const surnameUpdated = yield* run(
            runAction({
              registration: updatePartyAction,
              payload: {
                partyRef: second.partyRef,
                expectedRevision: named.revision,
                lastName: 'Lovelace',
                provenanceMethod: 'DOCUMENT',
                provenanceSource: 'live-acceptance',
                validFrom: '2022-01-01T00:00:00.000Z',
              },
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }),
          );
          expect(surnameUpdated.revision).toBe(named.revision + 1);
          const afterNames = yield* run(readPartyDetail(second.partyRef, managerReadPrincipal));
          expect(nameOf(afterNames, 'firstName')).toBe('Ada');
          expect(nameOf(afterNames, 'lastName')).toBe('Lovelace');
          expect(nameOf(afterNames, 'businessName')).toBe('Analytical Engines');
          expect(displayNameOf(afterNames)).toBe('Analytical Engines');
          expect(
            afterNames.currentFactAssertions.some((fact) => fact.factKind === 'LAST_NAME' && fact.value === 'Lovelace'),
          ).toBe(true);

          // A fresh same-value update is a new operation; replay is not.
          const beforeEqualUpdate = yield* snapshot();
          const equalUpdateTransport = yield* freshTransport;
          const equalUpdatePayload = {
            partyRef: second.partyRef,
            expectedRevision: surnameUpdated.revision,
            lastName: ' Lovelace ',
            provenanceMethod: 'DOCUMENT',
            provenanceSource: 'live-acceptance',
            validFrom: '2023-01-01T00:00:00.000Z',
          };
          const equalUpdated = yield* run(
            runAction({
              registration: updatePartyAction,
              payload: equalUpdatePayload,
              principal: managerPrincipal,
              transport: equalUpdateTransport,
            }),
          );
          expect(equalUpdated.revision).toBe(surnameUpdated.revision + 1);
          expect(Option.getOrNull(equalUpdated.lastName)).toBe('Lovelace');
          const equalDetail = yield* run(readPartyDetail(second.partyRef, managerReadPrincipal, true));
          const oldSurname = afterNames.currentFactAssertions.find((fact) => fact.factKind === 'LAST_NAME');
          const equalSurname = equalDetail.currentFactAssertions.find((fact) => fact.factKind === 'LAST_NAME');
          assert.isOk(oldSurname && equalSurname);
          expect(equalSurname.assertionId).not.toBe(oldSurname.assertionId);
          expect(equalSurname.value).toBe('Lovelace');
          expect(nameOf(equalDetail, 'firstName')).toBe('Ada');
          expect(nameOf(equalDetail, 'businessName')).toBe('Analytical Engines');
          expect(displayNameOf(equalDetail)).toBe('Analytical Engines');
          expect(historyOf(equalDetail)).toContainEqual(
            expect.objectContaining({ assertionId: oldSurname.assertionId, isCurrent: false, state: 'ENDED' }),
          );
          const afterEqualUpdate = yield* snapshot();
          expect(afterEqualUpdate.assertions.length).toBe(beforeEqualUpdate.assertions.length + 1);
          expect(afterEqualUpdate.core.events.length).toBe(beforeEqualUpdate.core.events.length + 1);
          expect(afterEqualUpdate.core.outbox.length).toBe(beforeEqualUpdate.core.outbox.length + 1);
          expect(afterEqualUpdate.core.audits.length).toBe(beforeEqualUpdate.core.audits.length + 1);
          assert.isOk(
            Predicate.isTagged(
              yield* run(
                runAction({
                  registration: updatePartyAction,
                  payload: equalUpdatePayload,
                  principal: managerPrincipal,
                  transport: equalUpdateTransport,
                }).pipe(Effect.flip),
              ),
              'ActionAlreadyCommitted',
            ),
          );
          expect(yield* snapshot()).toEqual(afterEqualUpdate);

          const corrections = [
            { factKind: 'FIRST_NAME', replacementValue: 'Augusta' },
            { factKind: 'LAST_NAME', replacementValue: 'King' },
            { factKind: 'BUSINESS_NAME', replacementValue: 'Corrected Engines' },
          ] as const;
          yield* Effect.forEach(
            corrections,
            Effect.fn('GovernedIdentityTest.correctStructuredName')(function* correctStructuredName(change) {
              const before = yield* run(readPartyDetail(second.partyRef, managerReadPrincipal));
              const target = before.currentFactAssertions.find((fact) => fact.factKind === change.factKind);
              assert.isOk(target);
              const payload = {
                ...change,
                partyId: second.partyRef.resourceId,
                targetAssertionId: target.assertionId,
                policyVersion: 'party-correction.v1' as const,
                evidenceRefs: ['review/structured-names'],
                evidenceSource: 'MANUAL_REVIEW' as const,
                reasonCode: 'WRONG_IDENTITY_VALUE' as const,
                provenance: { method: 'REVIEW', source: 'live-acceptance' },
              };
              const corrected = yield* run(
                runAction({
                  registration: correctPartyFactAction,
                  payload,
                  principal: managerPrincipal,
                  transport: yield* freshTransport,
                }),
              );
              expect(corrected.retractedAssertionId).toBe(target.assertionId);
              const replacementId = Option.getOrNull(corrected.replacementAssertionId);
              expect(replacementId).not.toBe(null);
              expect(replacementId).not.toBe(target.assertionId);
              const detail = yield* run(
                Effect.all([ReadRuntime, freshReadTransport]).pipe(
                  Effect.flatMap(([runtime, readTransport]) =>
                    runtime.runRead({
                      registration: partyCorrectionRead,
                      input: { correctionRef: corrected.correctionRef },
                      principal: managerReadPrincipal,
                      transport: readTransport,
                    }),
                  ),
                ),
              );
              const encodedDetail = yield* Schema.encodeEffect(PartyCorrectionResponseSchema)(detail);
              const decodedDetail = yield* Schema.decodeUnknownEffect(PartyCorrectionResponseSchema)(encodedDetail);
              expect(decodedDetail).toEqual(detail);
              expect(decodedDetail.correctionRef).toEqual(corrected.correctionRef);
              expect(decodedDetail.partyRef).toEqual(second.partyRef);
              expect(decodedDetail.factKind).toBe(change.factKind);
              expect(decodedDetail.targetAssertionId).toBe(target.assertionId);
              expect(Option.getOrNull(decodedDetail.replacementAssertionId)).toBe(replacementId);
              expect(decodedDetail.originalAssertion).toMatchObject({
                assertionId: target.assertionId,
                factKind: change.factKind,
                value: target.value,
                state: 'SUPERSEDED',
              });
              expect(resultingOf(decodedDetail)).toMatchObject({
                assertionId: replacementId,
                factKind: change.factKind,
                value: change.replacementValue,
                state: 'ACTIVE',
              });
              expect(decodedDetail.governance).toEqual(PartyCorrectionGovernance);
              expect(decodedDetail.actingPrincipalId).toBe(managerPrincipal.principalId);
              expect(decodedDetail.evidenceRefs).toEqual(payload.evidenceRefs);
              expect(decodedDetail.evidenceSource).toBe(payload.evidenceSource);
              expect(decodedDetail.reasonCode).toBe(payload.reasonCode);
              expect(decodedDetail.provenance).toEqual(payload.provenance);
              const after = yield* run(readPartyDetail(second.partyRef, managerReadPrincipal, true));
              expect(after.party.revision).toBe(before.party.revision + 1);
              const replacement = after.currentFactAssertions.find((fact) => fact.factKind === change.factKind);
              expect(replacement?.assertionId).toBe(replacementId);
              expect(replacement?.value).toBe(change.replacementValue);
              expect(historyOf(after).some((fact) => fact.assertionId === target.assertionId && !fact.isCurrent)).toBe(
                true,
              );
              assert.isOk(
                Predicate.isTagged(
                  yield* run(
                    runAction({
                      registration: correctPartyFactAction,
                      payload,
                      principal: managerPrincipal,
                      transport: yield* freshTransport,
                    }).pipe(Effect.flip),
                  ),
                  'PartyCorrectionConflict',
                ),
              );
              const afterStale = yield* run(readPartyDetail(second.partyRef, managerReadPrincipal));
              expect(afterStale.party.revision).toBe(after.party.revision);
            }),
            { concurrency: 1, discard: true },
          );
          const beforeTypeCorrection = yield* run(readPartyDetail(second.partyRef, managerReadPrincipal));
          const typeTarget = beforeTypeCorrection.currentFactAssertions.find((fact) => fact.factKind === 'PARTY_TYPE');
          assert.isOk(typeTarget);
          yield* run(
            runAction({
              registration: correctPartyFactAction,
              payload: {
                factKind: 'PARTY_TYPE',
                partyId: second.partyRef.resourceId,
                targetAssertionId: typeTarget.assertionId,
                replacementValue: 'PERSON',
                policyVersion: 'party-correction.v1',
                evidenceRefs: ['review/structured-type'],
                evidenceSource: 'MANUAL_REVIEW',
                reasonCode: 'WRONG_PARTY_TYPE',
                provenance: { method: 'REVIEW', source: 'live-acceptance' },
                subjectEvidence: [
                  {
                    kind: 'ACTOR_ATTESTATION',
                    basis: 'REVIEWED_DOCUMENT',
                    evidenceRef: 'review/structured-type',
                    observedSubject: 'PERSON',
                    subjectKey: 'subject',
                    statement: 'Reviewed the concrete external person in this fixture',
                  },
                ],
              },
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }),
          );
          const afterTypeCorrection = yield* run(readPartyDetail(second.partyRef, managerReadPrincipal));
          expect(afterTypeCorrection.party.partyType).toBe('PERSON');
          expect(nameOf(afterTypeCorrection, 'firstName')).toBe('Augusta');
          expect(nameOf(afterTypeCorrection, 'lastName')).toBe('King');
          expect(nameOf(afterTypeCorrection, 'businessName')).toBe('Corrected Engines');
          expect(displayNameOf(afterTypeCorrection)).toBe('Augusta King');
        }),
      ),
  );
});
