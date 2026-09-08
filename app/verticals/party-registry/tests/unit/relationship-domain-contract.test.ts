import { expect, it } from 'effect-rstest';
import { Effect, DateTime, Option, Schema, Predicate, Struct } from 'effect';
import {
  ContactPersonOfRelationshipType,
  CreatePartyRelationshipPayloadSchema,
  EndPartyRelationshipPayloadSchema,
  PartyRelationshipTypeSchema,
  UpdatePartyRelationshipPayloadSchema,
} from '../../shared/domain/relationship-contract.ts';
import {
  classifyRelationshipValidity,
  decideRelationshipCreate,
  decideRelationshipEnd,
  decideRelationshipUpdate,
} from '../../shared/domain/relationship-temporal.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const fromPartyRef = {
  moduleId: 'party.registry',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const toPartyRef = {
  ...fromPartyRef,
  resourceId: '33333333-3333-4333-8333-333333333333',
} as const;
const relationshipRef = {
  moduleId: 'party.registry',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'party.registry.party-relationship',
  tenantId,
} as const;
const provenance = {
  method: 'MANUAL_CONFIRMATION',
  source: 'ENGAGEMENT_REVIEW',
} as const;
const instant = DateTime.makeUnsafe;
const absentInstant = Option.none<DateTime.Utc>();
const presentInstant = (value: string) => Option.some(instant(value));

it.effect('the production catalog contains only CONTACT_PERSON_OF', () =>
  Effect.gen(function* schemaContract1() {
    expect(
      yield* Schema.decodeUnknownEffect(PartyRelationshipTypeSchema)('CONTACT_PERSON_OF'),
    ).toBe(ContactPersonOfRelationshipType);
    for (const deferred of ['EMPLOYEE_OF', 'BRANCH_OF', 'OTHER']) {
      expect(() => Schema.decodeUnknownSync(PartyRelationshipTypeSchema)(deferred)).toThrow();
    }
  }),
);

it.effect('create accepts one provenance-backed PERSON to ORGANIZATION period shape', () =>
  Effect.gen(function* schemaContract2() {
    const payload = {
      fromPartyRef,
      provenance,
      relationshipType: 'CONTACT_PERSON_OF',
      toPartyRef,
      validFrom: '2026-09-01T10:00:00.000Z',
      validTo: null,
    } as const;
    const decoded = yield* Schema.decodeUnknownEffect(CreatePartyRelationshipPayloadSchema)(
      payload,
    );
    expect(decoded.relationshipType).toBe('CONTACT_PERSON_OF');
    expect(() =>
      Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
        ...payload,
        toPartyRef: fromPartyRef,
      }),
    ).toThrow();
    expect(
      Option.isNone(
        (yield* Schema.decodeUnknownEffect(CreatePartyRelationshipPayloadSchema)({
          ...payload,
          validFrom: null,
        })).validFrom,
      ),
    ).toBe(true);
    expect(DateTime.formatIso(Option.getOrThrow(decoded.validFrom))).toBe(payload.validFrom);
    expect(() =>
      Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
        ...payload,
        validTo: '2026-09-01T10:00:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
        ...payload,
        validFrom: '2026-02-30T10:00:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
        ...payload,
        validFrom: '2026-09-01T10:00:00Z',
      }),
    ).toThrow();
  }),
);

it.effect('relationship timestamps and nullable periods preserve their JSON encoding', () =>
  Effect.gen(function* schemaContract3() {
    const wire = {
      fromPartyRef,
      provenance,
      relationshipType: 'CONTACT_PERSON_OF' as const,
      toPartyRef,
      validFrom: null,
      validTo: '2026-09-01T10:00:00.000Z',
    };
    const decoded = yield* Schema.decodeUnknownEffect(CreatePartyRelationshipPayloadSchema)({
      ...wire,
      validTo: null,
    });
    expect(yield* Schema.encodeEffect(CreatePartyRelationshipPayloadSchema)(decoded)).toEqual({
      ...wire,
      validTo: null,
    });
    const updated = yield* Schema.decodeUnknownEffect(UpdatePartyRelationshipPayloadSchema)({
      changeReason: 'Clarified end',
      expectedRevision: 1,
      provenance,
      relationshipRef,
      validTo: null,
    });
    expect(updated.validTo !== undefined && Option.isNone(updated.validTo)).toBe(true);
    expect(yield* Schema.encodeEffect(UpdatePartyRelationshipPayloadSchema)(updated)).toEqual({
      changeReason: 'Clarified end',
      expectedRevision: 1,
      provenance,
      relationshipRef,
      validTo: null,
    });
  }),
);

it.effect('update cannot accept endpoint or relationship type mutation fields', () =>
  Effect.gen(function* schemaContract4() {
    const decoded = yield* Schema.decodeUnknownEffect(UpdatePartyRelationshipPayloadSchema, {
      onExcessProperty: 'error',
    })({
      changeReason: 'The planned assignment was extended',
      expectedRevision: 2,
      provenance,
      relationshipRef,
      validFrom: '2026-10-01T10:00:00.000Z',
      validTo: '2026-12-01T10:00:00.000Z',
    });
    expect(decoded.expectedRevision).toBe(2);
    for (const forbiddenField of ['fromPartyRef', 'toPartyRef', 'relationshipType']) {
      expect(() =>
        Schema.decodeUnknownSync(UpdatePartyRelationshipPayloadSchema, {
          onExcessProperty: 'error',
        })({
          changeReason: 'The planned assignment was extended',
          expectedRevision: 2,
          provenance,
          relationshipRef,
          validFrom: '2026-10-01T10:00:00.000Z',
          validTo: '2026-12-01T10:00:00.000Z',
          [forbiddenField]: fromPartyRef,
        }),
      ).toThrow();
    }
  }),
);

it.effect(
  'end requires effective time, provenance, and revision without inventing a generic reason',
  () =>
    Effect.gen(function* schemaContract5() {
      const decoded = yield* Schema.decodeUnknownEffect(EndPartyRelationshipPayloadSchema)({
        effectiveAt: '2026-09-02T10:00:00.000Z',
        expectedRevision: 3,
        provenance,
        reason: 'The person is no longer a contact',
        relationshipRef,
      });
      expect(decoded.expectedRevision).toBe(3);
      expect(
        (yield* Schema.decodeUnknownEffect(EndPartyRelationshipPayloadSchema)({
          effectiveAt: '2026-09-02T10:00:00.000Z',
          expectedRevision: 3,
          provenance,
          relationshipRef,
        })).reason,
      ).toBe(undefined);
    }),
);

it('validity uses an exclusive end boundary', () => {
  expect(
    classifyRelationshipValidity(absentInstant, absentInstant, instant('2026-09-01T09:59:59.999Z')),
  ).toBe('CURRENT');
  expect(
    classifyRelationshipValidity(
      presentInstant('2026-09-01T10:00:00.000Z'),
      absentInstant,
      instant('2026-09-01T09:59:59.999Z'),
    ),
  ).toBe('SCHEDULED');
  expect(
    classifyRelationshipValidity(
      presentInstant('2026-09-01T10:00:00.000Z'),
      presentInstant('2026-09-02T10:00:00.000Z'),
      instant('2026-09-02T09:59:59.999Z'),
    ),
  ).toBe('CURRENT');
  expect(
    classifyRelationshipValidity(
      presentInstant('2026-09-01T10:00:00.000Z'),
      presentInstant('2026-09-02T10:00:00.000Z'),
      instant('2026-09-02T10:00:00.000Z'),
    ),
  ).toBe('HISTORICAL');
});

it('create reuses an exact period and conflicts on a distinct overlap', () => {
  const existing = {
    relationshipId: relationshipRef.resourceId,
    validFrom: presentInstant('2026-09-01T10:00:00.000Z'),
    validTo: presentInstant('2026-10-01T10:00:00.000Z'),
  } as const;
  const exactPeriodDecision = decideRelationshipCreate([existing], { ...existing });
  expect(Predicate.isTagged(exactPeriodDecision, 'reuse')).toBe(true);
  expect(Struct.omit(exactPeriodDecision, ['_tag'])).toEqual({
    relationshipId: relationshipRef.resourceId,
  });
  const overlappingPeriodDecision = decideRelationshipCreate([existing], {
    relationshipId: 'ignored',
    validFrom: presentInstant('2026-09-15T10:00:00.000Z'),
    validTo: absentInstant,
  });
  expect(Predicate.isTagged(overlappingPeriodDecision, 'overlap')).toBe(true);
  expect(Struct.omit(overlappingPeriodDecision, ['_tag'])).toEqual({
    relationshipId: relationshipRef.resourceId,
  });
  const adjacentPeriodDecision = decideRelationshipCreate([existing], {
    relationshipId: 'ignored',
    validFrom: presentInstant('2026-10-01T10:00:00.000Z'),
    validTo: absentInstant,
  });
  expect(Predicate.isTagged(adjacentPeriodDecision, 'create')).toBe(true);
  expect(Struct.omit(adjacentPeriodDecision, ['_tag'])).toEqual({});
});

it('only a still-future validity plan is ordinarily updateable', () => {
  const futureEndUpdate = decideRelationshipUpdate(
    {
      revision: 2,
      validFrom: presentInstant('2026-01-01T00:00:00.000Z'),
      validTo: presentInstant('2026-12-01T00:00:00.000Z'),
    },
    {
      expectedRevision: 2,
      validFrom: undefined,
      validTo: presentInstant('2027-01-01T00:00:00.000Z'),
    },
    instant('2026-09-03T00:00:00.000Z'),
  );
  expect(Predicate.isTagged(futureEndUpdate, 'update')).toBe(true);
  expect(Struct.omit(futureEndUpdate, ['_tag'])).toEqual({});
  const historicalEndUpdate = decideRelationshipUpdate(
    {
      revision: 2,
      validFrom: presentInstant('2026-01-01T00:00:00.000Z'),
      validTo: presentInstant('2026-08-01T00:00:00.000Z'),
    },
    {
      expectedRevision: 2,
      validFrom: undefined,
      validTo: presentInstant('2027-01-01T00:00:00.000Z'),
    },
    instant('2026-09-03T00:00:00.000Z'),
  );
  expect(Predicate.isTagged(historicalEndUpdate, 'correction_required')).toBe(true);
  expect(Struct.omit(historicalEndUpdate, ['_tag'])).toEqual({ fact: 'validTo' });
  const pastEndUpdate = decideRelationshipUpdate(
    {
      revision: 2,
      validFrom: presentInstant('2026-01-01T00:00:00.000Z'),
      validTo: absentInstant,
    },
    {
      expectedRevision: 2,
      validTo: presentInstant('2026-08-01T00:00:00.000Z'),
    },
    instant('2026-09-03T00:00:00.000Z'),
  );
  expect(Predicate.isTagged(pastEndUpdate, 'end_required')).toBe(true);
  expect(Struct.omit(pastEndUpdate, ['_tag'])).toEqual({});
  const staleRevisionUpdate = decideRelationshipUpdate(
    {
      revision: 2,
      validFrom: presentInstant('2026-01-01T00:00:00.000Z'),
      validTo: absentInstant,
    },
    { expectedRevision: 1, validFrom: undefined, validTo: absentInstant },
    instant('2026-09-03T00:00:00.000Z'),
  );
  expect(Predicate.isTagged(staleRevisionUpdate, 'revision_conflict')).toBe(true);
  expect(Struct.omit(staleRevisionUpdate, ['_tag'])).toEqual({ actualRevision: 2 });
  const unknownStartUpdate = decideRelationshipUpdate(
    { revision: 2, validFrom: absentInstant, validTo: absentInstant },
    {
      expectedRevision: 2,
      validFrom: instant('2025-01-01T00:00:00.000Z'),
      validTo: undefined,
    },
    instant('2026-09-03T00:00:00.000Z'),
  );
  expect(Predicate.isTagged(unknownStartUpdate, 'update')).toBe(true);
  expect(Struct.omit(unknownStartUpdate, ['_tag'])).toEqual({});
  const futureStartUpdate = decideRelationshipUpdate(
    {
      revision: 2,
      validFrom: presentInstant('2027-01-01T00:00:00.000Z'),
      validTo: absentInstant,
    },
    {
      expectedRevision: 2,
      validFrom: instant('2027-02-01T00:00:00.000Z'),
      validTo: undefined,
    },
    instant('2026-09-03T00:00:00.000Z'),
  );
  expect(Predicate.isTagged(futureStartUpdate, 'update')).toBe(true);
  expect(Struct.omit(futureStartUpdate, ['_tag'])).toEqual({});
  const historicalStartUpdate = decideRelationshipUpdate(
    {
      revision: 2,
      validFrom: presentInstant('2026-01-01T00:00:00.000Z'),
      validTo: absentInstant,
    },
    {
      expectedRevision: 2,
      validFrom: instant('2026-02-01T00:00:00.000Z'),
      validTo: undefined,
    },
    instant('2026-09-03T00:00:00.000Z'),
  );
  expect(Predicate.isTagged(historicalStartUpdate, 'correction_required')).toBe(true);
  expect(Struct.omit(historicalStartUpdate, ['_tag'])).toEqual({ fact: 'validFrom' });
});

it('end retry is exact and changed historical evidence requires correction', () => {
  const current = {
    endProvenanceMethod: 'MANUAL_CONFIRMATION',
    endProvenanceSource: 'ENGAGEMENT_REVIEW',
    endReason: 'No longer a contact',
    revision: 3,
    validFrom: presentInstant('2026-01-01T00:00:00.000Z'),
    validTo: presentInstant('2026-08-01T00:00:00.000Z'),
  } as const;
  const exact = {
    effectiveAt: instant('2026-08-01T00:00:00.000Z'),
    expectedRevision: 3,
    provenance: { method: 'MANUAL_CONFIRMATION', source: 'ENGAGEMENT_REVIEW' },
    reason: 'No longer a contact',
  } as const;
  const exactEndRetry = decideRelationshipEnd(current, exact, instant('2026-09-03T00:00:00.000Z'));
  expect(Predicate.isTagged(exactEndRetry, 'unchanged')).toBe(true);
  expect(Struct.omit(exactEndRetry, ['_tag'])).toEqual({});
  const changedEndRetry = decideRelationshipEnd(
    current,
    { ...exact, reason: 'A different historical explanation' },
    instant('2026-09-03T00:00:00.000Z'),
  );
  expect(Predicate.isTagged(changedEndRetry, 'correction_required')).toBe(true);
  expect(Struct.omit(changedEndRetry, ['_tag'])).toEqual({ fact: 'validTo' });
  const missingEndEvidence = decideRelationshipEnd(
    { ...current, endProvenanceMethod: null, endProvenanceSource: null, endReason: null },
    exact,
    instant('2026-09-03T00:00:00.000Z'),
  );
  expect(Predicate.isTagged(missingEndEvidence, 'attach_end_evidence')).toBe(true);
  expect(Struct.omit(missingEndEvidence, ['_tag'])).toEqual({});
});
