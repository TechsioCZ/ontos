// @effect-diagnostics asyncFunction:off -- node:test awaits the coordinator through the package's unit-test idiom; these tests assert on rejection shape, not on time or configuration. remove-when: a package-owned itEffect harness lands
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';

import { Effect, Option, Schema } from 'effect';
import { deriveAresEvidenceApplication } from '../../shared/domain/ares-application.ts';
import { AresSubjectEvidenceSchema } from '../../shared/domain/ares-evidence.ts';
import type { AresSubjectEvidence } from '../../shared/domain/ares-evidence.ts';

import {
  AresApplySelectionInvalid,
  applyAresObservationWithActions as applyAresObservation,
  makeActionGateway,
  makeAresApplySelectionInvalid,
  readAresApplySelectionOriginalCause,
} from '../../src/api/action-gateway.ts';
import type {
  AresApplyReads,
  AresApplyRequest,
  PartyRegistryStandardActionInvoker,
} from '../../src/api/action-gateway.ts';

const partyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party' as const,
  tenantId: '20000000-0000-4000-8000-000000000001',
};

const observedAt = '2026-09-03T10:00:00.000Z';

const evidence: AresSubjectEvidence = {
  cacheAgeSeconds: 0,
  observedAt,
  provider: 'ares',
  providerChangedOn: '2026-09-02',
  providerRecordRef: 'ares:12345678',
  queryIco: '12345678',
  servedAt: observedAt,
  status: 'FOUND',
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
};

/** Type-valid but schema-invalid: `cacheAgeSeconds` must be a non-negative integer. */
const malformedEvidence: AresSubjectEvidence = { ...evidence, cacheAgeSeconds: -1 };

const request: AresApplyRequest = {
  correlationId: 'ares-failure-cause-correlation',
  observation: evidence,
  partyRef,
  selections: [
    {
      fact: 'BUSINESS_NAME',
      idempotencyKey: 'ares-cause-name-1',
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
      idempotencyKey: 'ares-cause-ico-1',
      payload: {
        identifier: { identifierType: 'ICO', value: '12345678', verification: 'VERIFIED' },
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

const calls: string[] = [];
const invoker: PartyRegistryStandardActionInvoker<never> = {
  addContactPoint: () => {
    calls.push('add-contact-point');
    return Effect.never;
  },
  addPartyOfficialIdentifier: () => {
    calls.push('add-party-official-identifier');
    return Effect.never;
  },
  updateParty: () => {
    calls.push('update-party');
    return Effect.never;
  },
};

const gateway = makeActionGateway(() =>
  Effect.succeed({ expiresAt: 1_788_430_000, token: 'signed-gateway-token' }),
);

const makeReads = (refreshed: AresSubjectEvidence): AresApplyReads => ({
  contactPoints: () => Effect.succeed({ items: [] }),
  identifiers: () => Effect.succeed({ items: [] }),
  observation: () => Effect.succeed(refreshed),
  party: () =>
    Effect.succeed({
      currentFactAssertions: [],
      factHistory: null,
      party: {
        archivedAt: null,
        createdAt: '2026-09-01T10:00:00.000Z',
        displayName: null,
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

const isSelectionInvalid = Schema.is(AresApplySelectionInvalid);

/** Runs the coordinator and returns the rejection it fails with. */
const rejectionOf = (applyRequest: AresApplyRequest, reads: AresApplyReads) =>
  applyAresObservation(applyRequest, invoker, { gateway, reads }).pipe(
    Effect.result,
    Effect.map((result) => {
      assert.ok('failure' in result);
      assert.ok(isSelectionInvalid(result.failure));
      return result.failure;
    }),
  );

/** Captures the original failure the collaborator raises for the same malformed evidence. */
const originalFailureOf = (act: () => unknown): unknown => {
  let captured: unknown;
  assert.throws(act, (error: unknown) => {
    captured = error;
    return true;
  });
  return captured;
};

/** The two shapes a rejection reaches a client as. */
const wireFormsOf = (rejection: AresApplySelectionInvalid) => ({
  encoded: Schema.encodeSync(AresApplySelectionInvalid)(rejection) as unknown,
  serialized: JSON.parse(JSON.stringify(rejection)) as unknown,
});

/** Every way a rejection can be rendered on the way out of the process. */
const renderingsOf = (rejection: AresApplySelectionInvalid): readonly string[] => [
  JSON.stringify(rejection),
  JSON.stringify(Schema.encodeSync(AresApplySelectionInvalid)(rejection)),
  inspect(rejection),
  inspect(rejection, { depth: null }),
  String(rejection),
  `${rejection.stack}`,
];

test('preserves the supplied-observation decode failure as the rejection cause', async () => {
  const decodeFailure = originalFailureOf(() =>
    Schema.decodeUnknownSync(AresSubjectEvidenceSchema)(malformedEvidence),
  );

  const rejection = await Effect.runPromise(
    rejectionOf({ ...request, observation: malformedEvidence }, makeReads(evidence)),
  );
  const cause = Option.getOrUndefined(readAresApplySelectionOriginalCause(rejection));

  assert.equal(rejection.code, 'ares_apply_selection_invalid');
  assert.equal(rejection.reason, 'ARES observation is not a bounded valid observation');
  assert.notEqual(cause, undefined);
  assert.equal(Schema.isSchemaError(cause), true);
  assert.equal(String(cause), String(decodeFailure));
  assert.deepEqual(calls, []);
});

test('preserves the owner-policy evaluation defect as the rejection cause', async () => {
  const policyDefect = originalFailureOf(() =>
    deriveAresEvidenceApplication({
      canonical: null,
      decidedAt: observedAt,
      evidence: malformedEvidence,
      selectedFacts: ['BUSINESS_NAME', 'ICO'],
      userConfirmed: true,
    }),
  );

  const rejection = await Effect.runPromise(rejectionOf(request, makeReads(malformedEvidence)));
  const cause = Option.getOrUndefined(readAresApplySelectionOriginalCause(rejection));

  assert.equal(rejection.code, 'ares_apply_selection_invalid');
  assert.equal(
    rejection.reason,
    'The trusted ARES evidence cannot be evaluated under the owner policy',
  );
  assert.notEqual(cause, undefined);
  assert.equal(Object.getPrototypeOf(cause), Object.getPrototypeOf(policyDefect));
  assert.equal(String(cause), String(policyDefect));
  assert.deepEqual(calls, []);
});

test('keeps the established rejection vocabulary when there is no original failure', async () => {
  const rejection = await Effect.runPromise(
    rejectionOf({ ...request, userConfirmed: false }, makeReads(evidence)),
  );

  assert.equal(rejection._tag, 'AresApplySelectionInvalid');
  assert.equal(rejection.code, 'ares_apply_selection_invalid');
  assert.equal(rejection.reason, 'Explicit user confirmation and a correlation ID are required');
  assert.equal(Option.isNone(readAresApplySelectionOriginalCause(rejection)), true);
  assert.deepEqual(calls, []);
});

test('never renders a credential quoted by the preserved provider failure', () => {
  const syntheticCredential = 'SYNTHETIC-ares-key-9f3c2a41d7b04e6b';
  const providerFailure = new Error(
    `ARES rejected the lookup (authorization: Bearer ${syntheticCredential})`,
  );
  const rejection = makeAresApplySelectionInvalid(
    'ARES observation is not a bounded valid observation',
    providerFailure,
  );

  // The preserved failure really does quote the credential, so the assertions below mean something.
  assert.equal(inspect(providerFailure, { depth: null }).includes(syntheticCredential), true);
  assert.equal(
    Option.getOrUndefined(readAresApplySelectionOriginalCause(rejection)),
    providerFailure,
  );

  for (const rendering of renderingsOf(rejection)) {
    assert.equal(rendering.includes(syntheticCredential), false, rendering);
    assert.equal(rendering.includes('ARES rejected the lookup'), false, rendering);
  }

  // The rejection carries no `cause` of its own, which Node's error inspection would print.
  assert.equal((rejection as { cause?: unknown }).cause, undefined);
  assert.equal(Object.hasOwn(rejection, 'cause'), false);
  // It survives as a non-enumerable, symbol-keyed property, which no ordinary rendering walks.
  assert.equal(
    Object.getOwnPropertySymbols(rejection).some(
      (key) => Object.getOwnPropertyDescriptor(rejection, key)?.enumerable === true,
    ),
    false,
  );
});

test('keeps the wire shape of a rejection down to _tag, code and reason', () => {
  const rejection = makeAresApplySelectionInvalid('ARES lookup failed', new Error('SYNTHETIC'));
  const wire = {
    _tag: 'AresApplySelectionInvalid',
    code: 'ares_apply_selection_invalid',
    reason: 'ARES lookup failed',
  };
  const { encoded, serialized } = wireFormsOf(rejection);

  assert.deepEqual(encoded, wire);
  assert.deepEqual(serialized, wire);
  assert.deepEqual(Object.keys(rejection).toSorted(), ['_tag', 'code', 'reason']);
});
