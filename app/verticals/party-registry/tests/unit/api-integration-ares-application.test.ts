import { DateTime, Effect, Layer, Match, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import {
  AresAppliedEvidenceSchema,
  makeAresAppliedEvidence,
  deriveAresEvidenceApplication,
} from '../../shared/domain/ares-application.ts';
import type { AresAppliedEvidence } from '../../shared/domain/ares-application.ts';
import { AresSubjectEvidenceSchema } from '../../shared/domain/ares-evidence.ts';
import {
  AssertionIdSchema,
  TargetAssertionIdSchema,
} from '../../shared/domain/correction-contracts.ts';
import { PartyIdSchema } from '../../shared/domain/identity-contracts.ts';
import {
  AresApplySelectionInvalid,
  applyAresObservationWithActions as applyAresObservation,
  makeOperationGateway,
} from '../../src/api/action-gateway.ts';
import type {
  AresApplyRequest,
  AresApplyReads,
  PartyRegistryStandardActionInvoker,
} from '../../src/api/action-gateway.ts';

const partyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party' as const,
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const confirmedAt = '2026-09-03T10:10:00.000Z';
const confirmedInstant = DateTime.makeUnsafe(confirmedAt);
const confirmedAtEpoch = DateTime.toEpochMillis(confirmedInstant);
const actionValidFrom = DateTime.makeUnsafe('2026-09-03T09:59:00.000Z');
const partyCreatedAt = DateTime.makeUnsafe('2026-09-01T10:00:00.000Z');
const partyUpdatedAt = DateTime.makeUnsafe('2026-09-03T10:00:00.000Z');
const currentAssertionId = Result.getOrThrow(
  Schema.decodeUnknownResult(AssertionIdSchema)(
    '30000000-0000-4000-8000-000000000001'
  )
);
const application = {
  decidedAt: confirmedAt,
  evidence: {
    cacheAgeSeconds: 0,
    observedAt: confirmedAt,
    provider: 'ares' as const,
    providerChangedOn: '2026-09-02',
    providerRecordRef: 'ares:12345678',
    queryIco: '12345678',
    servedAt: confirmedAt,
    status: 'FOUND' as const,
    subject: {
      businessName: 'Example s.r.o.',
      dic: 'CZ12345678',
      dissolvedOn: null,
      establishedOn: '2020-01-01',
      ico: '12345678',
      legalFormCode: '112',
      registeredAddress: {
        buildingNumber: '10',
        countryCode: 'CZ',
        formatted: 'Main 10, Prague',
        municipality: 'Prague',
        municipalityPart: null,
        orientationNumber: null,
        postalCode: '11000',
        street: 'Main',
      },
    },
  },
  factDecisions: [
    {
      authorityPolicyKey: 'party.ares.authority',
      authorityPolicyVersion: '1',
      fact: 'BUSINESS_NAME' as const,
      outcome: 'APPLY_ENRICHMENT' as const,
      reasonCode: 'user_confirmed_name',
      route: 'PARTY_UPDATE' as const,
    },
    {
      authorityPolicyKey: 'party.ares.authority',
      authorityPolicyVersion: '1',
      fact: 'ICO' as const,
      outcome: 'APPLY_ENRICHMENT' as const,
      reasonCode: 'user_confirmed_ico',
      route: 'IDENTIFIER_ADD' as const,
    },
  ],
  outcome: 'APPLY_ENRICHMENT' as const,
  userConfirmed: true,
};
const decodedObservation = Result.getOrThrow(
  Schema.decodeUnknownResult(AresSubjectEvidenceSchema)(application.evidence)
);
const request: AresApplyRequest = {
  correlationId: 'ares-test-correlation',
  observation: application.evidence,
  partyRef,
  selections: [
    {
      fact: 'BUSINESS_NAME',
      idempotencyKey: 'ares-name-1',
      payload: {
        displayName: 'Example s.r.o.',
        expectedRevision: 1,
        partyRef,
        provenanceMethod: 'ARES_USER_CONFIRMED',
        provenanceSource: 'ares:12345678',
        validFrom: actionValidFrom,
      },
      route: 'PARTY_UPDATE',
    },
    {
      fact: 'ICO',
      idempotencyKey: 'ares-ico-1',
      payload: {
        identifier: {
          identifierType: 'ICO',
          value: '12345678',
          verification: 'VERIFIED',
        },
        partyRef,
        provenanceMethod: 'ARES_USER_CONFIRMED',
        provenanceSource: 'ares:12345678',
        validFrom: actionValidFrom,
      },
      route: 'IDENTIFIER_ADD',
    },
  ],
  userConfirmed: true,
};
class TestFailure extends Schema.TaggedError<TestFailure>()('TestFailure', {
  action: Schema.String,
}) {}
const makeInvoker = (
  calls: string[],
  failAction?: string
): PartyRegistryStandardActionInvoker<TestFailure> => {
  const complete = <Value>(action: string, value: Value) => {
    calls.push(action);
    return failAction === action
      ? Effect.fail(new TestFailure({ action }))
      : Effect.succeed(value);
  };
  return {
    addContactPoint: () => Effect.never,
    addPartyOfficialIdentifier: (_payload, authorization) =>
      complete(`add-party-official-identifier|${authorization}`, {
        officialIdentifierRef: {
          moduleId: 'party.registry' as const,
          resourceId: '40000000-0000-4000-8000-000000000001',
          resourceType: 'party.registry.party-official-identifier' as const,
          tenantId: partyRef.tenantId,
        },
        partyRef,
      }),
    updateParty: (_payload, authorization) =>
      complete(`update-party|${authorization}`, {
        archivedAt: Option.none(),
        createdAt: partyCreatedAt,
        displayName: Option.some('Example s.r.o.'),
        partyRef,
        partyType: 'ORGANIZATION' as const,
        revision: 2,
        updatedAt: partyUpdatedAt,
      }),
  };
};
const gateway = makeOperationGateway(() =>
  Effect.succeed({ expiresAt: 1_788_430_000, token: 'signed-gateway-token' })
);
const makeReads = (displayName: string | null = null): AresApplyReads => ({
  contactPoints: () => Effect.succeed({ items: [] }),
  identifiers: () => Effect.succeed({ items: [] }),
  observation: () => Effect.succeed(decodedObservation),
  party: () =>
    Effect.succeed({
      currentFactAssertions: [],
      factHistory: Option.none(),
      party: {
        archivedAt: Option.none(),
        createdAt: partyCreatedAt,
        displayName:
          displayName === null ? Option.none() : Option.some(displayName),
        partyRef,
        partyType: 'ORGANIZATION',
        revision: 1,
        updatedAt: partyUpdatedAt,
      },
      resolution: {
        aliasChain: [],
        canonicalPartyRef: partyRef,
        kind: 'DIRECT',
        requestedPartyRef: partyRef,
      },
    }),
});
it.layer(Layer.effectDiscard(TestClock.setTime(confirmedAtEpoch)))(
  'ARES application',
  (aresIt) => {
    aresIt.effect(
      'runs only explicitly selected standard Actions and preserves every result',
      () =>
        Effect.gen(function* runsOnlyExplicitlySelectedStandard() {
          const calls: string[] = [];
          const outcome = yield* applyAresObservation(
            request,
            makeInvoker(calls),
            {
              gateway,
              reads: makeReads(),
            }
          );
          expect(calls).toEqual([
            'update-party|Bearer signed-gateway-token',
            'add-party-official-identifier|Bearer signed-gateway-token',
          ]);
          expect(
            Match.value(outcome).pipe(
              Match.tag('AresApplyCompleted', () => true),
              Match.orElse(() => false)
            )
          ).toBe(true);
          expect(outcome.completed.map(({ route }) => route)).toEqual([
            'PARTY_UPDATE',
            'IDENTIFIER_ADD',
          ]);
        })
    );
    aresIt.effect(
      'propagates bounded evidence and independent command delivery keys',
      () =>
        Effect.gen(function* propagatesBoundedEvidenceAndIndependent() {
          const calls: string[] = [];
          const recorded: {
            readonly evidenceRef: string | undefined;
            readonly idempotencyKey: string;
          }[] = [];
          const delegate = makeInvoker(calls);
          const invoker: PartyRegistryStandardActionInvoker<TestFailure> = {
            ...delegate,
            addPartyOfficialIdentifier: (payload, authorization, options) => {
              recorded.push({
                evidenceRef: payload.externalEvidence?.evidenceRef,
                idempotencyKey: options.idempotencyKey,
              });
              return delegate.addPartyOfficialIdentifier(
                payload,
                authorization,
                options
              );
            },
            updateParty: (payload, authorization, options) => {
              recorded.push({
                evidenceRef: payload.externalEvidence?.evidenceRef,
                idempotencyKey: options.idempotencyKey,
              });
              return delegate.updateParty(payload, authorization, options);
            },
          };
          yield* applyAresObservation(request, invoker, {
            baseUrl: 'https://party.example/party-registry-api',
            gateway,
            reads: makeReads(),
          });
          expect(recorded.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
            'ares-name-1',
            'ares-ico-1',
          ]);
          expect(
            recorded.every(({ evidenceRef }) =>
              evidenceRef === undefined
                ? false
                : evidenceRef.includes('ares:12345678')
            )
          ).toBe(true);
        })
    );
    aresIt.effect(
      'stops after the first failed Action and returns a typed partial outcome',
      () =>
        Effect.gen(function* stopsAfterTheFirstFailed() {
          const calls: string[] = [];
          const outcome = yield* applyAresObservation(
            request,
            makeInvoker(
              calls,
              'add-party-official-identifier|Bearer signed-gateway-token'
            ),
            { gateway, reads: makeReads() }
          );
          expect(calls).toEqual([
            'update-party|Bearer signed-gateway-token',
            'add-party-official-identifier|Bearer signed-gateway-token',
          ]);
          const partial = Match.value(outcome).pipe(
            Match.tag('AresApplyPartiallyCompleted', (value) => value),
            Match.orElse(() =>
              expect.unreachable(
                'Expected a partially completed ARES application'
              )
            )
          );
          expect(partial.completed.map(({ route }) => route)).toEqual([
            'PARTY_UPDATE',
          ]);
          expect(partial.failed.route).toBe('IDENTIFIER_ADD');
          expect(
            Match.value(partial.failed.error).pipe(
              Match.tag('TestFailure', () => true),
              Match.orElse(() => false)
            )
          ).toBe(true);
        })
    );
    aresIt.effect(
      'resumes a replay after a prior selected fact is already satisfied',
      () =>
        Effect.gen(function* resumesAReplayAfterA() {
          const calls: string[] = [];
          const outcome = yield* applyAresObservation(
            request,
            makeInvoker(calls),
            {
              gateway,
              reads: makeReads('Example s.r.o.'),
            }
          );
          expect(calls).toEqual([
            'add-party-official-identifier|Bearer signed-gateway-token',
          ]);
          expect(
            Match.value(outcome).pipe(
              Match.tag('AresApplyCompleted', () => true),
              Match.orElse(() => false)
            )
          ).toBe(true);
          expect(outcome.skipped).toEqual([
            {
              fact: 'BUSINESS_NAME',
              reason: 'ALREADY_SATISFIED',
              route: 'PARTY_UPDATE',
            },
          ]);
          expect(outcome.completed.map(({ route }) => route)).toEqual([
            'IDENTIFIER_ADD',
          ]);
        })
    );
    aresIt.effect(
      'defers when canonical revision or refreshed evidence changed',
      () =>
        Effect.gen(function* defersWhenCanonicalRevisionOr() {
          const calls: string[] = [];
          const revisionRequest: AresApplyRequest = {
            ...request,
            selections: request.selections.map((selection) =>
              selection.route === 'PARTY_UPDATE'
                ? {
                    ...selection,
                    payload: { ...selection.payload, expectedRevision: 2 },
                  }
                : selection
            ),
          };
          const changedReads: AresApplyReads = {
            ...makeReads(),
            observation: () =>
              Effect.succeed({
                ...decodedObservation,
                subject: {
                  ...decodedObservation.subject,
                  businessName: Option.some('Changed at provider'),
                },
              }),
          };
          const [revisionOutcome, changedOutcome] = yield* Effect.all(
            [
              applyAresObservation(revisionRequest, makeInvoker(calls), {
                gateway,
                reads: makeReads(),
              }),
              applyAresObservation(request, makeInvoker(calls), {
                gateway,
                reads: changedReads,
              }),
            ],
            { concurrency: 'unbounded' }
          );
          expect(
            Match.value(revisionOutcome).pipe(
              Match.tag('AresApplyDeferred', () => true),
              Match.orElse(() => false)
            )
          ).toBe(true);
          expect(
            Match.value(changedOutcome).pipe(
              Match.tag('AresApplyDeferred', () => true),
              Match.orElse(() => false)
            )
          ).toBe(true);
          expect(calls).toEqual([]);
        })
    );
    aresIt.effect(
      'rejects unconfirmed or observation-mismatched selections before invoking an Action',
      () =>
        Effect.gen(
          function* rejectsUnconfirmedOrObservationmismatchedSelections() {
            const calls: string[] = [];
            const invalidRequests: readonly AresApplyRequest[] = [
              {
                ...request,
                userConfirmed: false,
              },
              {
                correlationId: request.correlationId,
                observation: request.observation,
                partyRef,
                selections: [
                  {
                    fact: 'BUSINESS_NAME',
                    idempotencyKey: 'ares-invalid-name-1',
                    payload: {
                      displayName: 'Injected name',
                      expectedRevision: 1,
                      partyRef,
                      provenanceMethod: 'ARES_USER_CONFIRMED',
                      provenanceSource: 'ares:12345678',
                      validFrom: actionValidFrom,
                    },
                    route: 'PARTY_UPDATE',
                  },
                ],
                userConfirmed: true,
              },
            ];
            const results = yield* Effect.all(
              invalidRequests.map((invalidRequest) =>
                applyAresObservation(invalidRequest, makeInvoker(calls), {
                  gateway,
                  reads: makeReads(),
                }).pipe(Effect.result)
              ),
              { concurrency: 'unbounded' }
            );
            for (const result of results) {
              expect('failure' in result).toBe(true);
              if ('failure' in result) {
                expect(
                  Schema.is(AresApplySelectionInvalid)(result.failure)
                ).toBe(true);
              }
            }
            expect(calls).toEqual([]);
          }
        )
    );
    aresIt.effect(
      'does not accept a different street number as the observed registered address',
      () =>
        Effect.gen(function* doesNotAcceptADifferent() {
          const calls: string[] = [];
          const invalidRequest: AresApplyRequest = {
            correlationId: request.correlationId,
            observation: request.observation,
            partyRef,
            selections: [
              {
                fact: 'REGISTERED_ADDRESS',
                idempotencyKey: 'ares-address-1',
                payload: {
                  contactPoint: {
                    address: {
                      addressLine1: 'Main 100',
                      city: 'Prague',
                      countryCode: 'CZ',
                      postalCode: '11000',
                    },
                    purposes: [
                      {
                        preferred: false,
                        purpose: 'REGISTERED',
                        registryContext: {
                          jurisdiction: 'CZ',
                          registryKey: 'ARES',
                        },
                      },
                    ],
                    type: 'ADDRESS',
                  },
                  partyRef,
                  privacyClassification: 'PUBLIC',
                  provenance: {
                    authoritative: true,
                    evidenceReference: 'ares:12345678',
                    method: 'PROVIDER_OBSERVATION',
                    source: 'EXTERNAL_EVIDENCE',
                  },
                  validFrom: decodedObservation.observedAt,
                  verification: { state: 'UNVERIFIED' },
                },
                route: 'CONTACT_POINT_ADD',
              },
            ],
            userConfirmed: true,
          };
          const result = yield* applyAresObservation(
            invalidRequest,
            makeInvoker(calls),
            {
              gateway,
              reads: makeReads(),
            }
          ).pipe(Effect.result);
          expect('failure' in result).toBe(true);
          expect(calls).toEqual([]);
        })
    );
    const historicalEvidence = (
      fact: 'BUSINESS_NAME' | 'ICO'
    ): AresAppliedEvidence => {
      const result = deriveAresEvidenceApplication({
        canonical: {
          archived: false,
          displayName: null,
          icoValues: [],
          identityAmbiguous: false,
          partyType: 'ORGANIZATION',
          registeredAddresses: [],
        },
        decidedAt: application.decidedAt,
        evidence: application.evidence,
        selectedFacts: [fact],
        userConfirmed: true,
      });
      const decision = Option.getOrThrow(
        Option.fromNullishOr(result.factDecisions[0])
      );
      expect(decision).toBeDefined();
      return makeAresAppliedEvidence(result, decision);
    };
    const correctionSelection: AresApplyRequest['selections'][number] = {
      fact: 'BUSINESS_NAME',
      idempotencyKey: 'review-only',
      payload: {
        evidenceRefs: ['review:ares'],
        evidenceSource: 'MANUAL_REVIEW',
        factKind: 'DISPLAY_NAME',
        partyId: Result.getOrThrow(
          Schema.decodeUnknownResult(PartyIdSchema)(partyRef.resourceId)
        ),
        policyVersion: 'party-correction.v1',
        provenance: { method: 'REVIEW', source: 'ARES' },
        reasonCode: 'WRONG_IDENTITY_VALUE',
        replacementValue: 'Example s.r.o.',
        targetAssertionId: Result.getOrThrow(
          Schema.decodeUnknownResult(TargetAssertionIdSchema)(
            '30000000-0000-4000-8000-000000000001'
          )
        ),
      },
      route: 'PARTY_CORRECTION',
    };
    aresIt.effect(
      'review-authorized assertion context returns explicit Correction handoff without a write',
      () =>
        Effect.gen(function* reviewauthorizedAssertionContextReturnsExplicit() {
          const calls: string[] = [];
          const reads = makeReads('Wrong name');
          let reviewed = false;
          const result = yield* applyAresObservation(
            { ...request, selections: [correctionSelection] },
            makeInvoker(calls),
            {
              gateway,
              reads: {
                ...reads,
                party: (payload, ...args) => {
                  reviewed = payload.includeFactHistory === true;
                  return reads.party(payload, ...args).pipe(
                    Effect.map((detail) => ({
                      ...detail,
                      currentFactAssertions: [
                        {
                          assertionId: currentAssertionId,
                          externalEvidence: Option.some(
                            historicalEvidence('BUSINESS_NAME')
                          ),
                          factKind: 'DISPLAY_NAME' as const,
                          isCurrent: true,
                          partyRef,
                          recordedAt: confirmedInstant,
                          retractsAssertionId: Option.none(),
                          state: 'ACTIVE' as const,
                          supersedesAssertionId: Option.none(),
                          validFrom: confirmedInstant,
                          validTo: Option.none(),
                          value: 'Wrong name',
                        },
                      ],
                    }))
                  );
                },
              },
            }
          );
          expect(reviewed).toBe(true);
          const deferred = Match.value(result).pipe(
            Match.tag('AresApplyDeferred', (value) => value),
            Match.orElse(() =>
              expect.unreachable('Expected a deferred ARES application')
            )
          );
          expect(deferred.application.outcome).toBe('CORRECTION_CANDIDATE');
          expect(deferred.correctionCandidates[0]?.targetAssertionId).toBe(
            '30000000-0000-4000-8000-000000000001'
          );
          expect(deferred.correctionCandidates[0]?.observedValue).toBe(
            'Example s.r.o.'
          );
          expect(calls).toEqual([]);
        })
    );
    aresIt.effect(
      'governed identifier history supports ICO correction suspicion without claiming the identifier',
      () =>
        Effect.gen(function* governedIdentifierHistorySupportsIco() {
          const calls: string[] = [];
          const selection = Option.getOrThrow(
            Option.fromNullishOr(request.selections[1])
          );
          expect(selection).toBeDefined();
          const encodedEvidence = yield* Schema.encodeEffect(
            AresAppliedEvidenceSchema
          )(historicalEvidence('ICO'));
          const outcome = yield* applyAresObservation(
            { ...request, selections: [selection] },
            makeInvoker(calls),
            {
              gateway,
              reads: {
                ...makeReads(),
                identifiers: () =>
                  Effect.succeed({
                    items: [
                      {
                        externalEvidence: encodedEvidence,
                        identifierType: 'ICO' as const,
                        namespace: 'CZ:ICO',
                        normalizedValue: '87654321',
                        officialIdentifierRef: {
                          moduleId: 'party.registry' as const,
                          resourceId: '40000000-0000-4000-8000-000000000001',
                          resourceType:
                            'party.registry.party-official-identifier' as const,
                          tenantId: partyRef.tenantId,
                        },
                        partyRef,
                        recordedAt: application.decidedAt,
                        state: 'ACTIVE' as const,
                        validFrom: application.decidedAt,
                        validTo: null,
                        verification: 'VERIFIED' as const,
                      },
                    ],
                  }),
              },
            }
          );
          const deferred = Match.value(outcome).pipe(
            Match.tag('AresApplyDeferred', (value) => value),
            Match.orElse(() =>
              expect.unreachable('Expected a deferred ARES application')
            )
          );
          expect(deferred.application.outcome).toBe('CORRECTION_CANDIDATE');
          expect(deferred.correctionCandidates[0]?.fact).toBe('ICO');
          expect(calls).toEqual([]);
        })
    );
    aresIt.effect(
      'every governed read and selected Action receives fresh audience-scoped authorization',
      () =>
        Effect.gen(function* everyGovernedReadAndSelected() {
          const tokens: string[] = [];
          const calls: string[] = [];
          const delegate = makeReads();
          const issued = makeOperationGateway(() => {
            const token = `token-${tokens.length + 1}`;
            tokens.push(token);
            return Effect.succeed({ expiresAt: 1_788_430_000, token });
          });
          const authorized: string[] = [];
          const reads: AresApplyReads = {
            contactPoints: (payload, authorization, ...rest) => {
              authorized.push(authorization);
              return delegate.contactPoints(payload, authorization, ...rest);
            },
            identifiers: (payload, authorization, ...rest) => {
              authorized.push(authorization);
              return delegate.identifiers(payload, authorization, ...rest);
            },
            observation: (payload, authorization, ...rest) => {
              authorized.push(authorization);
              return delegate.observation(payload, authorization, ...rest);
            },
            party: (payload, authorization, ...rest) => {
              authorized.push(authorization);
              expect(payload.includeFactHistory).toBe(undefined);
              return delegate.party(payload, authorization, ...rest);
            },
          };
          yield* applyAresObservation(request, makeInvoker(calls), {
            gateway: issued,
            reads,
          });
          expect(authorized).toEqual([
            'Bearer token-1',
            'Bearer token-2',
            'Bearer token-3',
            'Bearer token-4',
          ]);
          expect(calls).toEqual([
            'update-party|Bearer token-5',
            'add-party-official-identifier|Bearer token-6',
          ]);
        })
    );
    aresIt.effect(
      'read denial fails before writes and preserves its declared error',
      () =>
        Effect.gen(function* readDenialFailsBeforeWrites() {
          const calls: string[] = [];
          const denied = {
            _tag: 'PartyDetailForbiddenProblem' as const,
            detail: 'denied',
            status: 403 as const,
            title: 'Forbidden',
            type: 'urn:test:forbidden',
          };
          const result = yield* applyAresObservation(
            request,
            makeInvoker(calls),
            {
              gateway,
              reads: { ...makeReads(), party: () => Effect.fail(denied) },
            }
          ).pipe(Effect.result);
          expect('failure' in result && result.failure === denied).toBe(true);
          expect(calls).toEqual([]);
        })
    );
    aresIt.effect(
      'alias and archived targets never dispatch selected writes',
      () =>
        Effect.all(
          (['ALIAS', 'ARCHIVED'] as const).map((kind) =>
            Effect.gen(function* aliasAndArchivedTargetsNever() {
              const calls: string[] = [];
              const reads = makeReads();
              const result = yield* applyAresObservation(
                request,
                makeInvoker(calls),
                {
                  gateway,
                  reads: {
                    ...reads,
                    party: (...args) =>
                      reads.party(...args).pipe(
                        Effect.map((detail) => ({
                          ...detail,
                          party: {
                            ...detail.party,
                            archivedAt:
                              kind === 'ARCHIVED'
                                ? Option.some(confirmedInstant)
                                : Option.none(),
                          },
                          resolution: {
                            ...detail.resolution,
                            kind:
                              kind === 'ALIAS'
                                ? ('ALIAS' as const)
                                : ('DIRECT' as const),
                          },
                        }))
                      ),
                  },
                }
              ).pipe(Effect.result);
              if (kind === 'ALIAS') {
                expect('failure' in result).toBe(true);
              } else {
                expect('success' in result).toBe(true);
                if ('success' in result) {
                  Match.value(result.success).pipe(
                    Match.tag('AresApplyDeferred', () => null),
                    Match.orElse(() =>
                      expect.unreachable(
                        'Expected an archived Party to defer ARES application'
                      )
                    )
                  );
                }
              }
              expect(calls).toEqual([]);
            })
          ),
          { concurrency: 'unbounded' }
        )
    );
    aresIt.effect(
      'provider revision change alone invalidates the earlier confirmation',
      () =>
        Effect.gen(function* providerRevisionChangeAloneInvalidates() {
          const calls: string[] = [];
          const reads = makeReads();
          const outcome = yield* applyAresObservation(
            request,
            makeInvoker(calls),
            {
              gateway,
              reads: {
                ...reads,
                observation: (...args) =>
                  reads.observation(...args).pipe(
                    Effect.map((observed) => ({
                      ...observed,
                      providerChangedOn: Option.some(
                        DateTime.makeUnsafe('2026-09-03')
                      ),
                    }))
                  ),
              },
            }
          );
          expect(
            Match.value(outcome).pipe(
              Match.tag('AresApplyDeferred', () => true),
              Match.orElse(() => false)
            )
          ).toBe(true);
          expect(calls).toEqual([]);
        })
    );
    aresIt.effect(
      'retry preserves exact command payload and reports required standard recovery',
      () =>
        Effect.gen(function* retryPreservesExactCommandPayload() {
          const payloads: unknown[] = [];
          const calls: string[] = [];
          const delegate = makeInvoker(
            calls,
            'update-party|Bearer signed-gateway-token'
          );
          const invoker: PartyRegistryStandardActionInvoker<TestFailure> = {
            ...delegate,
            updateParty: (payload, auth, options) => {
              payloads.push({ options, payload });
              return delegate.updateParty(payload, auth, options);
            },
          };
          for (let retry = 0; retry < 2; retry += 1) {
            const result = yield* applyAresObservation(request, invoker, {
              gateway,
              reads: makeReads(),
            });
            const partial = Match.value(result).pipe(
              Match.tag('AresApplyPartiallyCompleted', (value) => value),
              Match.orElse(() =>
                expect.unreachable(
                  'Expected a partially completed ARES application'
                )
              )
            );
            expect(partial.failed.idempotencyKey).toBe('ares-name-1');
            expect(partial.failed.recovery).toBe(
              'RESOLVE_STANDARD_ACTION_BEFORE_RETRY'
            );
          }
          expect(payloads[0]).toEqual(payloads[1]);
          expect(calls).toEqual([
            'update-party|Bearer signed-gateway-token',
            'update-party|Bearer signed-gateway-token',
          ]);
        })
    );
    aresIt.effect(
      'failed second Action stops the following supported address and retains prior commit receipt',
      () =>
        Effect.gen(function* failedSecondActionStopsThe() {
          const calls: string[] = [];
          const address: AresApplyRequest['selections'][number] = {
            fact: 'REGISTERED_ADDRESS',
            idempotencyKey: 'ares-address-1',
            payload: {
              contactPoint: {
                address: {
                  addressLine1: 'Main 10',
                  city: 'Prague',
                  countryCode: 'CZ',
                  postalCode: '11000',
                },
                purposes: [
                  {
                    preferred: false,
                    purpose: 'REGISTERED',
                    registryContext: {
                      jurisdiction: 'CZ',
                      registryKey: 'ARES',
                    },
                  },
                ],
                type: 'ADDRESS',
              },
              partyRef,
              privacyClassification: 'PUBLIC',
              provenance: {
                authoritative: true,
                evidenceReference: 'ares:12345678',
                method: 'PROVIDER_OBSERVATION',
                source: 'EXTERNAL_EVIDENCE',
              },
              validFrom: decodedObservation.observedAt,
              verification: { state: 'UNVERIFIED' },
            },
            route: 'CONTACT_POINT_ADD',
          };
          const delegate = makeInvoker(
            calls,
            'add-party-official-identifier|Bearer signed-gateway-token'
          );
          const outcome = yield* applyAresObservation(
            { ...request, selections: [...request.selections, address] },
            {
              ...delegate,
              addContactPoint: () => {
                calls.push('unexpected-address');
                return Effect.fail(new TestFailure({ action: 'address' }));
              },
            },
            { gateway, reads: makeReads() }
          );
          expect(
            Match.value(outcome).pipe(
              Match.tag('AresApplyPartiallyCompleted', () => true),
              Match.orElse(() => false)
            )
          ).toBe(true);
          expect(outcome.completed.length).toBe(1);
          expect(calls).toEqual([
            'update-party|Bearer signed-gateway-token',
            'add-party-official-identifier|Bearer signed-gateway-token',
          ]);
        })
    );
    aresIt.effect(
      'stale refreshed evidence and missing canonical target cannot execute enrichment',
      () =>
        Effect.gen(function* staleRefreshedEvidenceAndMissing() {
          const calls: string[] = [];
          const stale = yield* applyAresObservation(
            request,
            makeInvoker(calls),
            {
              gateway,
              reads: {
                ...makeReads(),
                observation: () =>
                  Effect.succeed({
                    ...decodedObservation,
                    observedAt: DateTime.makeUnsafe('2026-09-03T09:59:00.000Z'),
                    servedAt: DateTime.makeUnsafe('2026-09-03T10:00:00.000Z'),
                  }),
              },
            }
          );
          expect(
            Match.value(stale).pipe(
              Match.tag('AresApplyDeferred', () => true),
              Match.orElse(() => false)
            )
          ).toBe(true);
          const absent = yield* applyAresObservation(
            { ...request, partyRef: null },
            makeInvoker(calls),
            {
              gateway,
              reads: makeReads(),
            }
          ).pipe(Effect.result);
          expect('failure' in absent).toBe(true);
          expect(calls).toEqual([]);
        })
    );
    aresIt.effect(
      'fresh identical refresh cannot revive an expired original confirmation',
      () =>
        Effect.gen(function* freshIdenticalRefreshCannotRevive() {
          const calls: string[] = [];
          const outcome = yield* applyAresObservation(
            {
              ...request,
              observation: {
                ...request.observation,
                observedAt: '2026-09-03T09:59:00.000Z',
                servedAt: '2026-09-03T10:00:00.000Z',
              },
            },
            makeInvoker(calls),
            { gateway, reads: makeReads() }
          );
          const deferred = Match.value(outcome).pipe(
            Match.tag('AresApplyDeferred', (value) => value),
            Match.orElse(() =>
              expect.unreachable(
                'Expected an expired confirmation to defer ARES application'
              )
            )
          );
          expect(deferred.application.factDecisions[0]?.reasonCode).toBe(
            'observation_not_fresh'
          );
          expect(deferred.correctionCandidates).toEqual([]);
          expect(calls).toEqual([]);
        })
    );
    aresIt.effect(
      'a correction route is never historical-error evidence by itself',
      () =>
        Effect.gen(function* aCorrectionRouteIsNever() {
          const calls: string[] = [];
          const outcome = yield* applyAresObservation(
            { ...request, selections: [correctionSelection] },
            makeInvoker(calls),
            {
              gateway,
              reads: makeReads('Wrong name'),
            }
          );
          const deferred = Match.value(outcome).pipe(
            Match.tag('AresApplyDeferred', (value) => value),
            Match.orElse(() =>
              expect.unreachable(
                'Expected the correction selection to defer ARES application'
              )
            )
          );
          expect(deferred.application.outcome).toBe('NEEDS_CONFIRMATION');
          expect(deferred.correctionCandidates).toEqual([]);
          expect(calls).toEqual([]);
        })
    );
  }
);
