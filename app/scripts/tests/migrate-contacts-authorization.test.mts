import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planContactsAuthorizationContext,
  type ContactsAuthorizationRelationship,
} from '../migrate-contacts-authorization.mts';

const legacyRelationships: readonly ContactsAuthorizationRelationship[] = [
  { relation: 'legal_entity', subjectId: 'legal-entity', subjectType: 'legal_entity' },
  { relation: 'accessor', subjectId: 'principal', subjectType: 'principal' },
];

test('prepare creates Contacts relationships from a legacy-only context', () => {
  assert.deepEqual(planContactsAuthorizationContext('prepare', legacyRelationships, []), {
    deleteLegacy: false,
    state: 'legacy_only',
    touchContacts: true,
  });
});

test('prepare and verify accept an exactly prepared context', () => {
  const reordered = [...legacyRelationships].reverse();
  assert.equal(
    planContactsAuthorizationContext('prepare', legacyRelationships, reordered).state,
    'already_prepared',
  );
  assert.equal(
    planContactsAuthorizationContext('verify', legacyRelationships, reordered).state,
    'already_prepared',
  );
});

test('finalize removes only an exactly matched legacy context', () => {
  assert.deepEqual(
    planContactsAuthorizationContext('finalize', legacyRelationships, legacyRelationships),
    { deleteLegacy: true, state: 'already_prepared', touchContacts: false },
  );
});

test('all modes are idempotent after legacy relationships are gone', () => {
  for (const mode of ['prepare', 'verify', 'finalize'] as const) {
    assert.deepEqual(planContactsAuthorizationContext(mode, [], legacyRelationships), {
      deleteLegacy: false,
      state: 'already_finalized',
      touchContacts: false,
    });
  }
});

test('verify and finalize fail closed when Contacts relationships are missing', () => {
  for (const mode of ['verify', 'finalize'] as const) {
    assert.throws(
      () => planContactsAuthorizationContext(mode, legacyRelationships, []),
      /Contacts authorization is missing/u,
    );
  }
});

test('every mode rejects partial or divergent relationship sets', () => {
  const partial = legacyRelationships.slice(0, 1);
  for (const mode of ['prepare', 'verify', 'finalize'] as const) {
    assert.throws(
      () => planContactsAuthorizationContext(mode, legacyRelationships, partial),
      /relationships differ/u,
    );
  }
});
