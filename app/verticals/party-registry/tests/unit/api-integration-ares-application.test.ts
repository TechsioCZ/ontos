// @effect-diagnostics asyncFunction:off instanceOfSchema:off
import assert from 'node:assert/strict';
import test from 'node:test';

import { DateTime, Effect, Redacted } from 'effect';
import {
  makeAresAppliedEvidence,
  deriveAresEvidenceApplication,
} from '../../shared/domain/ares-application.ts';
import type { AresAppliedEvidence } from '../../shared/domain/ares-application.ts';

import {
  AresApplySelectionInvalid,
  applyAresObservationWithActions as applyAresObservation,
  makeActionGateway,
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

const confirmedAt = Effect.runSync(DateTime.now.pipe(Effect.map(DateTime.formatIso)));
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
        validFrom: '2026-09-03T09:59:00.000Z',
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
        validFrom: '2026-09-03T09:59:00.000Z',
      },
      route: 'IDENTIFIER_ADD',
    },
  ],
  userConfirmed: true,
};

class TestFailure {
  readonly _tag = 'TestFailure';
  readonly action: string;
  constructor(action: string) {
    this.action = action;
  }
}

const makeInvoker = (
  calls: string[],
  failAction?: string,
): PartyRegistryStandardActionInvoker<TestFailure> => {
  const complete = <Value>(action: string, value: Value) => {
    calls.push(action);
    return failAction === action ? Effect.fail(new TestFailure(action)) : Effect.succeed(value);
  };
  return {
    addContactPoint: () => Effect.never,
    addPartyOfficialIdentifier: (_payload, authorization) =>
      complete(`add-party-official-identifier|${Redacted.value(authorization)}`, {
        officialIdentifierRef: {
          moduleId: 'party.registry' as const,
          resourceId: '40000000-0000-4000-8000-000000000001',
          resourceType: 'party.registry.party-official-identifier' as const,
          tenantId: partyRef.tenantId,
        },
        partyRef,
      }),
    updateParty: (_payload, authorization) =>
      complete(`update-party|${Redacted.value(authorization)}`, {
        archivedAt: null,
        createdAt: '2026-09-01T10:00:00.000Z',
        displayName: 'Example s.r.o.',
        partyRef,
        partyType: 'ORGANIZATION' as const,
        revision: 2,
        updatedAt: '2026-09-03T10:00:00.000Z',
      }),
  };
};

const gateway = makeActionGateway(() =>
  Effect.succeed({ expiresAt: 1_788_430_000, token: 'signed-gateway-token' }),
);

const makeReads = (displayName: string | null = null): AresApplyReads => ({
  contactPoints: () => Effect.succeed({ items: [] }),
  identifiers: () => Effect.succeed({ items: [] }),
  observation: () =>
    DateTime.now.pipe(
      Effect.map((now) => ({
        ...application.evidence,
        observedAt: DateTime.formatIso(now),
        servedAt: DateTime.formatIso(now),
      })),
    ),
  party: () =>
    Effect.succeed({
      currentFactAssertions: [],
      factHistory: null,
      party: {
        archivedAt: null,
        createdAt: '2026-09-01T10:00:00.000Z',
        displayName,
        partyRef,
        partyType: 'ORGANIZATION',
        revision: 1,
        updatedAt: '2026-09-03T10:00:00.000Z',
      },
      resolution: {
        aliasChain: [],
        canonicalPartyRef: partyRef,
        kind: 'DIRECT',
        requestedPartyRef: partyRef,
      },
    }),
});

test('runs only explicitly selected standard Actions and preserves every result', async () => {
  const calls: string[] = [];
  const outcome = await Effect.runPromise(
    applyAresObservation(request, makeInvoker(calls), { gateway, reads: makeReads() }),
  );

  assert.deepEqual(calls, [
    'update-party|Bearer signed-gateway-token',
    'add-party-official-identifier|Bearer signed-gateway-token',
  ]);
  assert.equal(outcome._tag, 'AresApplyCompleted');
  assert.deepEqual(
    outcome.completed.map(({ route }) => route),
    ['PARTY_UPDATE', 'IDENTIFIER_ADD'],
  );
});

test('propagates bounded evidence and independent command delivery keys', async () => {
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
      return delegate.addPartyOfficialIdentifier(payload, authorization, options);
    },
    updateParty: (payload, authorization, options) => {
      recorded.push({
        evidenceRef: payload.externalEvidence?.evidenceRef,
        idempotencyKey: options.idempotencyKey,
      });
      return delegate.updateParty(payload, authorization, options);
    },
  };

  await Effect.runPromise(
    applyAresObservation(request, invoker, {
      baseUrl: 'https://party.example/party-registry-api',
      gateway,
      reads: makeReads(),
    }),
  );

  assert.deepEqual(
    recorded.map(({ idempotencyKey }) => idempotencyKey),
    ['ares-name-1', 'ares-ico-1'],
  );
  assert.equal(
    recorded.every(({ evidenceRef }) =>
      evidenceRef === undefined ? false : evidenceRef.includes('ares:12345678'),
    ),
    true,
  );
});

test('stops after the first failed Action and returns a typed partial outcome', async () => {
  const calls: string[] = [];
  const outcome = await Effect.runPromise(
    applyAresObservation(
      request,
      makeInvoker(calls, 'add-party-official-identifier|Bearer signed-gateway-token'),
      { gateway, reads: makeReads() },
    ),
  );

  assert.deepEqual(calls, [
    'update-party|Bearer signed-gateway-token',
    'add-party-official-identifier|Bearer signed-gateway-token',
  ]);
  assert.equal(outcome._tag, 'AresApplyPartiallyCompleted');
  if (outcome._tag !== 'AresApplyPartiallyCompleted') {
    return;
  }
  assert.deepEqual(
    outcome.completed.map(({ route }) => route),
    ['PARTY_UPDATE'],
  );
  assert.equal(outcome.failed.route, 'IDENTIFIER_ADD');
  assert.equal(outcome.failed.error._tag, 'TestFailure');
});

test('resumes a replay after a prior selected fact is already satisfied', async () => {
  const calls: string[] = [];
  const outcome = await Effect.runPromise(
    applyAresObservation(request, makeInvoker(calls), {
      gateway,
      reads: makeReads('Example s.r.o.'),
    }),
  );

  assert.deepEqual(calls, ['add-party-official-identifier|Bearer signed-gateway-token']);
  assert.equal(outcome._tag, 'AresApplyCompleted');
  assert.deepEqual(outcome.skipped, [
    { fact: 'BUSINESS_NAME', reason: 'ALREADY_SATISFIED', route: 'PARTY_UPDATE' },
  ]);
  assert.deepEqual(
    outcome.completed.map(({ route }) => route),
    ['IDENTIFIER_ADD'],
  );
});

test('defers when canonical revision or refreshed evidence changed', async () => {
  const calls: string[] = [];
  const revisionRequest: AresApplyRequest = {
    ...request,
    selections: request.selections.map((selection) =>
      selection.route === 'PARTY_UPDATE'
        ? { ...selection, payload: { ...selection.payload, expectedRevision: 2 } }
        : selection,
    ),
  };
  const changedReads: AresApplyReads = {
    ...makeReads(),
    observation: () =>
      DateTime.now.pipe(
        Effect.map((now) => ({
          ...application.evidence,
          observedAt: DateTime.formatIso(now),
          servedAt: DateTime.formatIso(now),
          subject: { ...application.evidence.subject, businessName: 'Changed at provider' },
        })),
      ),
  };
  const [revisionOutcome, changedOutcome] = await Promise.all([
    Effect.runPromise(
      applyAresObservation(revisionRequest, makeInvoker(calls), { gateway, reads: makeReads() }),
    ),
    Effect.runPromise(
      applyAresObservation(request, makeInvoker(calls), { gateway, reads: changedReads }),
    ),
  ]);

  assert.equal(revisionOutcome._tag, 'AresApplyDeferred');
  assert.equal(changedOutcome._tag, 'AresApplyDeferred');
  assert.deepEqual(calls, []);
});

test('rejects unconfirmed or observation-mismatched selections before invoking an Action', async () => {
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
            validFrom: '2026-09-03T09:59:00.000Z',
          },
          route: 'PARTY_UPDATE',
        },
      ],
      userConfirmed: true,
    },
  ];

  const results = await Promise.all(
    invalidRequests.map((invalidRequest) =>
      Effect.runPromise(
        applyAresObservation(invalidRequest, makeInvoker(calls), {
          gateway,
          reads: makeReads(),
        }).pipe(Effect.result),
      ),
    ),
  );
  for (const result of results) {
    assert.equal('failure' in result, true);
    if ('failure' in result) {
      assert.equal(result.failure instanceof AresApplySelectionInvalid, true);
    }
  }
  assert.deepEqual(calls, []);
});

test('does not accept a different street number as the observed registered address', async () => {
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
                registryContext: { jurisdiction: 'CZ', registryKey: 'ARES' },
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
          validFrom: application.evidence.observedAt,
          verification: { state: 'UNVERIFIED' },
        },
        route: 'CONTACT_POINT_ADD',
      },
    ],
    userConfirmed: true,
  };
  const result = await Effect.runPromise(
    applyAresObservation(invalidRequest, makeInvoker(calls), { gateway, reads: makeReads() }).pipe(
      Effect.result,
    ),
  );
  assert.equal('failure' in result, true);
  assert.deepEqual(calls, []);
});

const historicalEvidence = (fact: 'BUSINESS_NAME' | 'ICO'): AresAppliedEvidence => {
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
  const [decision] = result.factDecisions;
  assert.ok(decision);
  return makeAresAppliedEvidence(result, decision);
};
const correctionSelection: AresApplyRequest['selections'][number] = {
  fact: 'BUSINESS_NAME',
  idempotencyKey: 'review-only',
  payload: {
    evidenceRefs: ['review:ares'],
    evidenceSource: 'MANUAL_REVIEW',
    factKind: 'DISPLAY_NAME',
    partyId: partyRef.resourceId,
    policyVersion: 'party-correction.v1',
    provenance: { method: 'REVIEW', source: 'ARES' },
    reasonCode: 'WRONG_IDENTITY_VALUE',
    replacementValue: 'Example s.r.o.',
    targetAssertionId: '30000000-0000-4000-8000-000000000001',
  },
  route: 'PARTY_CORRECTION',
};

test('review-authorized assertion context returns explicit Correction handoff without a write', async () => {
  const calls: string[] = [];
  const reads = makeReads('Wrong name');
  let reviewed = false;
  const result = await Effect.runPromise(
    applyAresObservation({ ...request, selections: [correctionSelection] }, makeInvoker(calls), {
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
                  assertionId: '30000000-0000-4000-8000-000000000001',
                  externalEvidence: historicalEvidence('BUSINESS_NAME'),
                  factKind: 'DISPLAY_NAME' as const,
                  isCurrent: true,
                  partyRef,
                  recordedAt: application.decidedAt,
                  retractsAssertionId: null,
                  state: 'ACTIVE' as const,
                  supersedesAssertionId: null,
                  validFrom: application.decidedAt,
                  validTo: null,
                  value: 'Wrong name',
                },
              ],
            })),
          );
        },
      },
    }),
  );
  assert.equal(reviewed, true);
  assert.equal(result._tag, 'AresApplyDeferred');
  if (result._tag !== 'AresApplyDeferred') {
    return;
  }
  assert.equal(result.application.outcome, 'CORRECTION_CANDIDATE');
  assert.equal(
    result.correctionCandidates[0]?.targetAssertionId,
    '30000000-0000-4000-8000-000000000001',
  );
  assert.equal(result.correctionCandidates[0]?.observedValue, 'Example s.r.o.');
  assert.deepEqual(calls, []);
});

test('governed identifier history supports ICO correction suspicion without claiming the identifier', async () => {
  const calls: string[] = [];
  const [, selection] = request.selections;
  assert.ok(selection);
  const outcome = await Effect.runPromise(
    applyAresObservation({ ...request, selections: [selection] }, makeInvoker(calls), {
      gateway,
      reads: {
        ...makeReads(),
        identifiers: () =>
          Effect.succeed({
            items: [
              {
                externalEvidence: historicalEvidence('ICO'),
                identifierType: 'ICO' as const,
                namespace: 'CZ:ICO',
                normalizedValue: '87654321',
                officialIdentifierRef: {
                  moduleId: 'party.registry' as const,
                  resourceId: '40000000-0000-4000-8000-000000000001',
                  resourceType: 'party.registry.party-official-identifier' as const,
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
    }),
  );
  assert.equal(outcome._tag, 'AresApplyDeferred');
  if (outcome._tag !== 'AresApplyDeferred') {
    return;
  }
  assert.equal(outcome.application.outcome, 'CORRECTION_CANDIDATE');
  assert.equal(outcome.correctionCandidates[0]?.fact, 'ICO');
  assert.deepEqual(calls, []);
});

test('every governed read and selected Action receives fresh audience-scoped authorization', async () => {
  const tokens: string[] = [];
  const calls: string[] = [];
  const delegate = makeReads();
  const issued = makeActionGateway(() => {
    const token = `token-${tokens.length + 1}`;
    tokens.push(token);
    return Effect.succeed({ expiresAt: 1_788_430_000, token });
  });
  const authorized: string[] = [];
  const reads: AresApplyReads = {
    contactPoints: (payload, authorization, ...rest) => {
      authorized.push(Redacted.value(authorization));
      return delegate.contactPoints(payload, authorization, ...rest);
    },
    identifiers: (payload, authorization, ...rest) => {
      authorized.push(Redacted.value(authorization));
      return delegate.identifiers(payload, authorization, ...rest);
    },
    observation: (payload, authorization, ...rest) => {
      authorized.push(Redacted.value(authorization));
      return delegate.observation(payload, authorization, ...rest);
    },
    party: (payload, authorization, ...rest) => {
      authorized.push(Redacted.value(authorization));
      assert.equal(payload.includeFactHistory, undefined);
      return delegate.party(payload, authorization, ...rest);
    },
  };
  await Effect.runPromise(
    applyAresObservation(request, makeInvoker(calls), { gateway: issued, reads }),
  );
  assert.deepEqual(authorized, [
    'Bearer token-1',
    'Bearer token-2',
    'Bearer token-3',
    'Bearer token-4',
  ]);
  assert.deepEqual(calls, [
    'update-party|Bearer token-5',
    'add-party-official-identifier|Bearer token-6',
  ]);
});

test('read denial fails before writes and preserves its declared error', async () => {
  const calls: string[] = [];
  const denied = {
    _tag: 'PartyDetailForbiddenProblem' as const,
    detail: 'denied',
    status: 403 as const,
    title: 'Forbidden',
    type: 'urn:test:forbidden',
  };
  const result = await Effect.runPromise(
    applyAresObservation(request, makeInvoker(calls), {
      gateway,
      reads: { ...makeReads(), party: () => Effect.fail(denied) },
    }).pipe(Effect.result),
  );
  assert.equal('failure' in result && result.failure === denied, true);
  assert.deepEqual(calls, []);
});

test('alias and archived targets never dispatch selected writes', async () => {
  await Promise.all(
    (['ALIAS', 'ARCHIVED'] as const).map(async (kind) => {
      const calls: string[] = [];
      const reads = makeReads();
      const result = await Effect.runPromise(
        applyAresObservation(request, makeInvoker(calls), {
          gateway,
          reads: {
            ...reads,
            party: (...args) =>
              reads.party(...args).pipe(
                Effect.map((detail) => ({
                  ...detail,
                  party: {
                    ...detail.party,
                    archivedAt: kind === 'ARCHIVED' ? application.decidedAt : null,
                  },
                  resolution: {
                    ...detail.resolution,
                    kind: kind === 'ALIAS' ? ('ALIAS' as const) : ('DIRECT' as const),
                  },
                })),
              ),
          },
        }).pipe(Effect.result),
      );
      if (kind === 'ALIAS') {
        assert.equal('failure' in result, true);
      } else {
        assert.equal('success' in result && result.success._tag === 'AresApplyDeferred', true);
      }
      assert.deepEqual(calls, []);
    }),
  );
});

test('provider revision change alone invalidates the earlier confirmation', async () => {
  const calls: string[] = [];
  const reads = makeReads();
  const outcome = await Effect.runPromise(
    applyAresObservation(request, makeInvoker(calls), {
      gateway,
      reads: {
        ...reads,
        observation: (...args) =>
          reads.observation(...args).pipe(
            Effect.map((observed) => ({
              ...observed,
              providerChangedOn: '2026-09-03',
            })),
          ),
      },
    }),
  );
  assert.equal(outcome._tag, 'AresApplyDeferred');
  assert.deepEqual(calls, []);
});

test('retry preserves exact command payload and reports required standard recovery', async () => {
  const payloads: unknown[] = [];
  const calls: string[] = [];
  const delegate = makeInvoker(calls, 'update-party|Bearer signed-gateway-token');
  const invoker: PartyRegistryStandardActionInvoker<TestFailure> = {
    ...delegate,
    updateParty: (payload, auth, options) => {
      payloads.push({ options, payload });
      return delegate.updateParty(payload, auth, options);
    },
  };
  for (let retry = 0; retry < 2; retry += 1) {
    // eslint-disable-next-line no-await-in-loop -- Retry must follow the completed first attempt.
    const result = await Effect.runPromise(
      applyAresObservation(request, invoker, { gateway, reads: makeReads() }),
    );
    assert.equal(result._tag, 'AresApplyPartiallyCompleted');
    if (result._tag !== 'AresApplyPartiallyCompleted') {
      return;
    }
    assert.equal(result.failed.idempotencyKey, 'ares-name-1');
    assert.equal(result.failed.recovery, 'RESOLVE_STANDARD_ACTION_BEFORE_RETRY');
  }
  assert.deepEqual(payloads[0], payloads[1]);
  assert.deepEqual(calls, [
    'update-party|Bearer signed-gateway-token',
    'update-party|Bearer signed-gateway-token',
  ]);
});

test('failed second Action stops the following supported address and retains prior commit receipt', async () => {
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
            registryContext: { jurisdiction: 'CZ', registryKey: 'ARES' },
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
      validFrom: application.evidence.observedAt,
      verification: { state: 'UNVERIFIED' },
    },
    route: 'CONTACT_POINT_ADD',
  };
  const delegate = makeInvoker(calls, 'add-party-official-identifier|Bearer signed-gateway-token');
  const outcome = await Effect.runPromise(
    applyAresObservation(
      { ...request, selections: [...request.selections, address] },
      {
        ...delegate,
        addContactPoint: () => {
          calls.push('unexpected-address');
          return Effect.fail(new TestFailure('address'));
        },
      },
      { gateway, reads: makeReads() },
    ),
  );
  assert.equal(outcome._tag, 'AresApplyPartiallyCompleted');
  assert.equal(outcome.completed.length, 1);
  assert.deepEqual(calls, [
    'update-party|Bearer signed-gateway-token',
    'add-party-official-identifier|Bearer signed-gateway-token',
  ]);
});

test('stale refreshed evidence and missing canonical target cannot execute enrichment', async () => {
  const calls: string[] = [];
  const stale = await Effect.runPromise(
    applyAresObservation(request, makeInvoker(calls), {
      gateway,
      reads: {
        ...makeReads(),
        observation: () =>
          Effect.succeed({
            ...application.evidence,
            observedAt: '2026-09-03T09:59:00.000Z',
            servedAt: '2026-09-03T10:00:00.000Z',
          }),
      },
    }),
  );
  assert.equal(stale._tag, 'AresApplyDeferred');
  const absent = await Effect.runPromise(
    applyAresObservation({ ...request, partyRef: null }, makeInvoker(calls), {
      gateway,
      reads: makeReads(),
    }).pipe(Effect.result),
  );
  assert.equal('failure' in absent, true);
  assert.deepEqual(calls, []);
});

test('fresh identical refresh cannot revive an expired original confirmation', async () => {
  const calls: string[] = [];
  const outcome = await Effect.runPromise(
    applyAresObservation(
      {
        ...request,
        observation: {
          ...request.observation,
          observedAt: '2026-09-03T09:59:00.000Z',
          servedAt: '2026-09-03T10:00:00.000Z',
        },
      },
      makeInvoker(calls),
      { gateway, reads: makeReads() },
    ),
  );
  assert.equal(outcome._tag, 'AresApplyDeferred');
  if (outcome._tag === 'AresApplyDeferred') {
    assert.equal(outcome.application.factDecisions[0]?.reasonCode, 'observation_not_fresh');
    assert.deepEqual(outcome.correctionCandidates, []);
  }
  assert.deepEqual(calls, []);
});

test('a correction route is never historical-error evidence by itself', async () => {
  const calls: string[] = [];
  const outcome = await Effect.runPromise(
    applyAresObservation({ ...request, selections: [correctionSelection] }, makeInvoker(calls), {
      gateway,
      reads: makeReads('Wrong name'),
    }),
  );
  assert.equal(outcome._tag, 'AresApplyDeferred');
  if (outcome._tag === 'AresApplyDeferred') {
    assert.equal(outcome.application.outcome, 'NEEDS_CONFIRMATION');
    assert.deepEqual(outcome.correctionCandidates, []);
  }
  assert.deepEqual(calls, []);
});
