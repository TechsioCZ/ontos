import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from 'effect';
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
  const decoded = Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
    fromPartyRef,
    provenance,
    relationshipType: 'CONTACT_PERSON_OF',
    toPartyRef,
    validFrom: '2026-09-01T10:00:00.000Z',
    validTo: null,
  });
  assert.equal(decoded.relationshipType, 'CONTACT_PERSON_OF');
  assert.throws(() =>
    Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
      ...decoded,
      toPartyRef: fromPartyRef,
    }),
  );
  assert.equal(
    Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
      ...decoded,
      validFrom: null,
    }).validFrom,
    null,
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
      ...decoded,
      validTo: '2026-09-01T10:00:00.000Z',
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
      ...decoded,
      validFrom: '2026-02-30T10:00:00.000Z',
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(CreatePartyRelationshipPayloadSchema)({
      ...decoded,
      validFrom: '2026-09-01T10:00:00Z',
    }),
  );
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
      })({ ...decoded, [forbiddenField]: fromPartyRef }),
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
  assert.equal(classifyRelationshipValidity(null, null, '2026-09-01T09:59:59.999Z'), 'CURRENT');
  assert.equal(
    classifyRelationshipValidity('2026-09-01T10:00:00.000Z', null, '2026-09-01T09:59:59.999Z'),
    'SCHEDULED',
  );
  assert.equal(
    classifyRelationshipValidity(
      '2026-09-01T10:00:00.000Z',
      '2026-09-02T10:00:00.000Z',
      '2026-09-02T09:59:59.999Z',
    ),
    'CURRENT',
  );
  assert.equal(
    classifyRelationshipValidity(
      '2026-09-01T10:00:00.000Z',
      '2026-09-02T10:00:00.000Z',
      '2026-09-02T10:00:00.000Z',
    ),
    'HISTORICAL',
  );
});

test('create reuses an exact period and conflicts on a distinct overlap', () => {
  const existing = {
    relationshipId: relationshipRef.resourceId,
    validFrom: '2026-09-01T10:00:00.000Z',
    validTo: '2026-10-01T10:00:00.000Z',
  } as const;
  assert.deepEqual(decideRelationshipCreate([existing], { ...existing }), {
    _tag: 'reuse',
    relationshipId: relationshipRef.resourceId,
  });
  assert.deepEqual(
    decideRelationshipCreate([existing], {
      relationshipId: 'ignored',
      validFrom: '2026-09-15T10:00:00.000Z',
      validTo: null,
    }),
    { _tag: 'overlap', relationshipId: relationshipRef.resourceId },
  );
  assert.deepEqual(
    decideRelationshipCreate([existing], {
      relationshipId: 'ignored',
      validFrom: '2026-10-01T10:00:00.000Z',
      validTo: null,
    }),
    { _tag: 'create' },
  );
});

test('only a still-future validity plan is ordinarily updateable', () => {
  assert.deepEqual(
    decideRelationshipUpdate(
      {
        revision: 2,
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2026-12-01T00:00:00.000Z',
      },
      {
        expectedRevision: 2,
        validFrom: undefined,
        validTo: '2027-01-01T00:00:00.000Z',
      },
      '2026-09-03T00:00:00.000Z',
    ),
    { _tag: 'update' },
  );
  assert.deepEqual(
    decideRelationshipUpdate(
      {
        revision: 2,
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2026-08-01T00:00:00.000Z',
      },
      {
        expectedRevision: 2,
        validFrom: undefined,
        validTo: '2027-01-01T00:00:00.000Z',
      },
      '2026-09-03T00:00:00.000Z',
    ),
    { _tag: 'correction_required', fact: 'validTo' },
  );
  assert.deepEqual(
    decideRelationshipUpdate(
      {
        revision: 2,
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null,
      },
      {
        expectedRevision: 2,
        validTo: '2026-08-01T00:00:00.000Z',
      },
      '2026-09-03T00:00:00.000Z',
    ),
    { _tag: 'end_required' },
  );
  assert.deepEqual(
    decideRelationshipUpdate(
      {
        revision: 2,
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null,
      },
      { expectedRevision: 1, validFrom: undefined, validTo: null },
      '2026-09-03T00:00:00.000Z',
    ),
    { _tag: 'revision_conflict', actualRevision: 2 },
  );
  assert.deepEqual(
    decideRelationshipUpdate(
      { revision: 2, validFrom: null, validTo: null },
      {
        expectedRevision: 2,
        validFrom: '2025-01-01T00:00:00.000Z',
        validTo: undefined,
      },
      '2026-09-03T00:00:00.000Z',
    ),
    { _tag: 'update' },
  );
  assert.deepEqual(
    decideRelationshipUpdate(
      {
        revision: 2,
        validFrom: '2027-01-01T00:00:00.000Z',
        validTo: null,
      },
      {
        expectedRevision: 2,
        validFrom: '2027-02-01T00:00:00.000Z',
        validTo: undefined,
      },
      '2026-09-03T00:00:00.000Z',
    ),
    { _tag: 'update' },
  );
  assert.deepEqual(
    decideRelationshipUpdate(
      {
        revision: 2,
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null,
      },
      {
        expectedRevision: 2,
        validFrom: '2026-02-01T00:00:00.000Z',
        validTo: undefined,
      },
      '2026-09-03T00:00:00.000Z',
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
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: '2026-08-01T00:00:00.000Z',
  } as const;
  const exact = {
    effectiveAt: '2026-08-01T00:00:00.000Z',
    expectedRevision: 3,
    provenance: { method: 'MANUAL_CONFIRMATION', source: 'ENGAGEMENT_REVIEW' },
    reason: 'No longer a contact',
  } as const;
  assert.deepEqual(decideRelationshipEnd(current, exact, '2026-09-03T00:00:00.000Z'), {
    _tag: 'unchanged',
  });
  assert.deepEqual(
    decideRelationshipEnd(
      current,
      { ...exact, reason: 'A different historical explanation' },
      '2026-09-03T00:00:00.000Z',
    ),
    { _tag: 'correction_required', fact: 'validTo' },
  );
  assert.deepEqual(
    decideRelationshipEnd(
      { ...current, endProvenanceMethod: null, endProvenanceSource: null, endReason: null },
      exact,
      '2026-09-03T00:00:00.000Z',
    ),
    { _tag: 'attach_end_evidence' },
  );
});
