import { ConfigProvider, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CreatePartyPayloadSchema } from '../../shared/actions/create-party.ts';
import {
  PartyDeclaredSubjectEligibilityVersion,
  PartyDeclaredTypeRuleVersion,
  PartySubjectEvidenceSchema,
} from '../../shared/domain/identity-contracts.ts';
import {
  evaluatePartySubjectEvidence,
  partyGuestBindingFailure,
} from '../../src/policies/create-party-without-strong-identifier.policy.ts';
import {
  authorizePartyEvidence,
  PartyClientSourcePrivacy,
} from '../../src/services/party-client-source-evidence.service.ts';

const tenantId = 'bc100000-0000-4000-8000-000000000001';
const principalId = 'bc200000-0000-4000-8000-000000000001';
const create = { operation: 'CREATE' } as const;
const actor = { authMethod: 'session', principalId, tenantId } as const;
const integration = { ...actor, authMethod: 'api_key' } as const;
const source = {
  issuer: 'internal-contract-fixture-issuer',
  namespace: 'customers',
  recordType: 'customer',
  routeRef: 'internal-contract-party-route',
};
const sourceAssertion = {
  kind: 'CLIENT_SOURCE_ASSERTION',
  observedSubject: 'PERSON',
  statement: 'Internal contract fixture declares this person',
  subjectKey: 'source-subject',
  source,
  recordId: 'source-record-1',
  occurrenceId: 'revision-1',
  sourceObservedAt: '1970-01-01T00:00:00.000Z',
} as const;
const manual = {
  kind: 'MANUAL_DECLARATION',
  observedSubject: 'PERSON',
  statement: 'Entered the name declared by this person',
} as const;

const decode = Schema.decodeUnknownSync(PartySubjectEvidenceSchema);
const encode = Schema.encodeSync(PartySubjectEvidenceSchema);

it('decodes honest manual evidence through the existing Create wire contract', () => {
  const { candidate } = Schema.decodeUnknownSync(CreatePartyPayloadSchema)({
    candidate: {
      evidenceRefs: [],
      officialIdentifiers: [],
      partyType: 'PERSON',
      firstName: 'Fixture',
      provenance: { method: 'DECLARATION', source: 'intake' },
      subjectEvidence: [manual],
      validFrom: '2025-01-01T00:00:00Z',
    },
  });
  expect(candidate.subjectEvidence?.map((item) => encode(item))).toEqual([manual]);
  expect(evaluatePartySubjectEvidence(candidate)).toMatchObject({
    reasonCode: 'declared_concrete_subject',
    subjectEligibilityVersion: PartyDeclaredSubjectEligibilityVersion,
    subjectEligible: true,
    typeRuleVersion: PartyDeclaredTypeRuleVersion,
    typeSupported: true,
  });
  expect(partyGuestBindingFailure(candidate, { tenantId })).toBeUndefined();
  expect(evaluatePartySubjectEvidence({ ...candidate, firstName: '   ' })).toMatchObject({
    reasonCode: 'declared_identity_fact_required',
    subjectEligible: false,
  });
});

it('rejects fake guest and actor evidence and malformed source observation dates', () => {
  expect(() => decode({ ...manual, guestBinding: {} })).toThrow();
  expect(() => decode({ ...manual, basis: 'REVIEWED_DOCUMENT' })).toThrow();
  expect(() => decode({ ...sourceAssertion, guestBinding: {} })).toThrow();
  expect(() => decode({ ...sourceAssertion, sourceObservedAt: 'unknown' })).toThrow();
  expect(encode(decode(sourceAssertion))).toEqual(sourceAssertion);
});

it('preserves the concrete type asserted by a client source', () => {
  const candidate = { firstName: 'Fixture', partyType: 'UNRESOLVED' as const };
  expect(evaluatePartySubjectEvidence({ ...candidate, subjectEvidence: [decode(sourceAssertion)] })).toMatchObject({
    reasonCode: 'party_type_evidence_required',
    subjectEligible: true,
    typeSupported: false,
  });
  expect(
    evaluatePartySubjectEvidence({
      ...candidate,
      subjectEvidence: [decode({ ...sourceAssertion, observedSubject: 'CONCRETE_SUBJECT' })],
    }),
  ).toMatchObject({ reasonCode: 'declared_concrete_subject', subjectEligible: true, typeSupported: true });
});

it.effect('manual and client-source assertions are admitted only in their verified owner scope', () =>
  Effect.gen(function* verifyAuthority() {
    const assertion = decode(sourceAssertion);
    const config = ConfigProvider.fromUnknown({
      ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))([
        { ...integration, ...source },
      ]),
    });
    yield* authorizePartyEvidence([decode(manual)], actor, create);
    expect((yield* Effect.flip(authorizePartyEvidence([decode(manual)], integration, create))).reason).toBe(
      'manual_declaration_requires_authenticated_actor',
    );
    const admitSource = authorizePartyEvidence([assertion], integration, create).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, config),
    );
    expect(yield* Effect.flip(admitSource)).toMatchObject({ code: 'party_persistence_unavailable' });
    yield* admitSource.pipe(
      Effect.provideService(PartyClientSourcePrivacy, {
        checkImport: () => Effect.succeed('ALLOWED'),
      }),
    );
    expect(
      yield* admitSource.pipe(
        Effect.provideService(PartyClientSourcePrivacy, { checkImport: () => Effect.succeed('DENIED') }),
        Effect.flip,
      ),
    ).toMatchObject({ reason: 'client_source_privacy_denied' });
    for (const operation of ['UPDATE', 'CORRECTION'] as const) {
      const amended = authorizePartyEvidence([assertion], integration, { operation, partyId: principalId }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, config),
        Effect.provideService(PartyClientSourcePrivacy, { checkImport: () => Effect.succeed('ALLOWED') }),
      );
      yield* amended;
    }
    for (const [evidence, context] of [
      [assertion, { ...integration, tenantId: principalId }],
      [assertion, actor],
      [decode({ ...sourceAssertion, source: { ...source, issuer: 'another-issuer' } }), integration],
    ] as const) {
      const denied = yield* authorizePartyEvidence([evidence], context, create).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, config),
        Effect.flip,
      );
      expect(denied).toMatchObject({ reason: 'client_source_not_authorized' });
    }
  }),
);
