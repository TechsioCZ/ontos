import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime, Option, Schema } from 'effect';
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

test('the production catalog contains only CONTACT_PERSON_OF', () => {
  assert.equal(
    Schema.decodeUnknownSync(PartyRelationshipTypeSchema)('CONTACT_PERSON_OF'),
    ContactPersonOfRelationshipType,
  );
  for (const deferred of ['EMPLOYEE_OF', 'BRANCH_OF', 'OTHER']) {
    assert.throws(() => Schema.decodeUnknownSync(PartyRelationshipTypeSchema)(deferred));
  }
});

test('create accepts one provenance-backed PERSON to ORGANIZATION period shape', () => {
  const payload = {
    fromPartyRef,
    provenance,
    relationshipType: 'CONTACT_PERSON_OF',
    toPartyRef,
    validFrom: '2026-09-01T10:00:00.000Z',
    validTo: null,
  } as const;
  const decoded = Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)(payload);
  assert.equal(decoded.relationshipType, 'CONTACT_PERSON_OF');
  assert.throws(() =>
    Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
      ...payload,
      toPartyRef: fromPartyRef,
    }),
  );
  assert.ok(
    Option.isNone(
      Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
        ...payload,
        validFrom: null,
      }).validFrom,
    ),
  );
  assert.equal(DateTime.formatIso(Option.getOrThrow(decoded.validFrom)), payload.validFrom);
  assert.throws(() =>
    Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
      ...payload,
      validTo: '2026-09-01T10:00:00.000Z',
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
      ...payload,
      validFrom: '2026-02-30T10:00:00.000Z',
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
      ...payload,
      validFrom: '2026-09-01T10:00:00Z',
    }),
  );
});

test('relationship timestamps and nullable periods preserve their JSON encoding', () => {
  const wire = {
    fromPartyRef,
    provenance,
    relationshipType: 'CONTACT_PERSON_OF' as const,
    toPartyRef,
    validFrom: null,
    validTo: '2026-09-01T10:00:00.000Z',
  };
  const decoded = Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
    ...wire,
    validTo: null,
  });
  assert.deepEqual(Schema.encodeSync(CreatePartyRelationshipPayloadSchema)(decoded), {
    ...wire,
    validTo: null,
  });
  const updated = Schema.decodeUnknownSync(UpdatePartyRelationshipPayloadSchema)({
    changeReason: 'Clarified end',
    expectedRevision: 1,
    provenance,
    relationshipRef,
    validTo: null,
  });
  assert.ok(updated.validTo !== undefined && Option.isNone(updated.validTo));
  assert.deepEqual(Schema.encodeSync(UpdatePartyRelationshipPayloadSchema)(updated), {
    changeReason: 'Clarified end',
    expectedRevision: 1,
    provenance,
    relationshipRef,
    validTo: null,
  });
});

test('update cannot accept endpoint or relationship type mutation fields', () => {
  const decoded = Schema.decodeUnknownSync(UpdatePartyRelationshipPayloadSchema, {
    onExcessProperty: 'error',
  })({
    changeReason: 'The planned assignment was extended',
    expectedRevision: 2,
    provenance,
    relationshipRef,
    validFrom: '2026-10-01T10:00:00.000Z',
    validTo: '2026-12-01T10:00:00.000Z',
  });
  assert.equal(decoded.expectedRevision, 2);
  for (const forbiddenField of ['fromPartyRef', 'toPartyRef', 'relationshipType']) {
    assert.throws(() =>
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
    );
  }
});

test('end requires effective time, provenance, and revision without inventing a generic reason', () => {
  const decoded = Schema.decodeUnknownSync(EndPartyRelationshipPayloadSchema)({
    effectiveAt: '2026-09-02T10:00:00.000Z',
    expectedRevision: 3,
    provenance,
    reason: 'The person is no longer a contact',
    relationshipRef,
  });
  assert.equal(decoded.expectedRevision, 3);
  assert.equal(
    Schema.decodeUnknownSync(EndPartyRelationshipPayloadSchema)({
      effectiveAt: '2026-09-02T10:00:00.000Z',
      expectedRevision: 3,
      provenance,
      relationshipRef,
    }).reason,
    undefined,
  );
});

test('validity uses an exclusive end boundary', () => {
  assert.equal(
    classifyRelationshipValidity(absentInstant, absentInstant, instant('2026-09-01T09:59:59.999Z')),
    'CURRENT',
  );
  assert.equal(
    classifyRelationshipValidity(
      presentInstant('2026-09-01T10:00:00.000Z'),
      absentInstant,
      instant('2026-09-01T09:59:59.999Z'),
    ),
    'SCHEDULED',
  );
  assert.equal(
    classifyRelationshipValidity(
      presentInstant('2026-09-01T10:00:00.000Z'),
      presentInstant('2026-09-02T10:00:00.000Z'),
      instant('2026-09-02T09:59:59.999Z'),
    ),
    'CURRENT',
  );
  assert.equal(
    classifyRelationshipValidity(
      presentInstant('2026-09-01T10:00:00.000Z'),
      presentInstant('2026-09-02T10:00:00.000Z'),
      instant('2026-09-02T10:00:00.000Z'),
    ),
    'HISTORICAL',
  );
});

test('create reuses an exact period and conflicts on a distinct overlap', () => {
  const existing = {
    relationshipId: relationshipRef.resourceId,
    validFrom: presentInstant('2026-09-01T10:00:00.000Z'),
    validTo: presentInstant('2026-10-01T10:00:00.000Z'),
  } as const;
  assert.deepEqual(decideRelationshipCreate([existing], { ...existing }), {
    _tag: 'reuse',
    relationshipId: relationshipRef.resourceId,
  });
  assert.deepEqual(
    decideRelationshipCreate([existing], {
      relationshipId: 'ignored',
      validFrom: presentInstant('2026-09-15T10:00:00.000Z'),
      validTo: absentInstant,
    }),
    { _tag: 'overlap', relationshipId: relationshipRef.resourceId },
  );
  assert.deepEqual(
    decideRelationshipCreate([existing], {
      relationshipId: 'ignored',
      validFrom: presentInstant('2026-10-01T10:00:00.000Z'),
      validTo: absentInstant,
    }),
    { _tag: 'create' },
  );
});

test('only a still-future validity plan is ordinarily updateable', () => {
  assert.deepEqual(
    decideRelationshipUpdate(
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
    ),
    { _tag: 'update' },
  );
  assert.deepEqual(
    decideRelationshipUpdate(
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
    ),
    { _tag: 'correction_required', fact: 'validTo' },
  );
  assert.deepEqual(
    decideRelationshipUpdate(
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
    ),
    { _tag: 'end_required' },
  );
  assert.deepEqual(
    decideRelationshipUpdate(
      {
        revision: 2,
        validFrom: presentInstant('2026-01-01T00:00:00.000Z'),
        validTo: absentInstant,
      },
      { expectedRevision: 1, validFrom: undefined, validTo: absentInstant },
      instant('2026-09-03T00:00:00.000Z'),
    ),
    { _tag: 'revision_conflict', actualRevision: 2 },
  );
  assert.deepEqual(
    decideRelationshipUpdate(
      { revision: 2, validFrom: absentInstant, validTo: absentInstant },
      {
        expectedRevision: 2,
        validFrom: instant('2025-01-01T00:00:00.000Z'),
        validTo: undefined,
      },
      instant('2026-09-03T00:00:00.000Z'),
    ),
    { _tag: 'update' },
  );
  assert.deepEqual(
    decideRelationshipUpdate(
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
    ),
    { _tag: 'update' },
  );
  assert.deepEqual(
    decideRelationshipUpdate(
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
    ),
    { _tag: 'correction_required', fact: 'validFrom' },
  );
});

test('end retry is exact and changed historical evidence requires correction', () => {
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
  assert.deepEqual(decideRelationshipEnd(current, exact, instant('2026-09-03T00:00:00.000Z')), {
    _tag: 'unchanged',
  });
  assert.deepEqual(
    decideRelationshipEnd(
      current,
      { ...exact, reason: 'A different historical explanation' },
      instant('2026-09-03T00:00:00.000Z'),
    ),
    { _tag: 'correction_required', fact: 'validTo' },
  );
  assert.deepEqual(
    decideRelationshipEnd(
      { ...current, endProvenanceMethod: null, endProvenanceSource: null, endReason: null },
      exact,
      instant('2026-09-03T00:00:00.000Z'),
    ),
    { _tag: 'attach_end_evidence' },
  );
});
