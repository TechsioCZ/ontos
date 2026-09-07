import assert from 'node:assert/strict';
import test from 'node:test';
import { planContactsAuthorizationContext } from '../migrate-contacts-authorization.mts';
import type { ContactsAuthorizationRelationship } from '../migrate-contacts-authorization.mts';

const legacyRelationships = [
  { relation: 'legal_entity', subjectId: 'legal-entity', subjectType: 'legal_entity' },
  { relation: 'accessor', subjectId: 'principal', subjectType: 'principal' },
] as const satisfies readonly ContactsAuthorizationRelationship[];
const prepareMode = 'prepare';
const verifyMode = 'verify';
const finalizeMode = 'finalize';
const alreadyPreparedState = 'already_prepared';

await test('prepare creates Contacts relationships from a legacy-only context', () => {
  assert.deepEqual(planContactsAuthorizationContext(prepareMode, legacyRelationships, []), {
    deleteLegacy: false,
    state: 'legacy_only',
    touchContacts: true,
  });
});

await test('prepare and verify accept an exactly prepared context', () => {
  const reordered = [legacyRelationships[1], legacyRelationships[0]] as const;
  assert.equal(
    planContactsAuthorizationContext(prepareMode, legacyRelationships, reordered).state,
    alreadyPreparedState,
  );
  assert.equal(
    planContactsAuthorizationContext(verifyMode, legacyRelationships, reordered).state,
    alreadyPreparedState,
  );
});

await test('finalize removes only an exactly matched legacy context', () => {
  assert.deepEqual(
    planContactsAuthorizationContext(finalizeMode, legacyRelationships, legacyRelationships),
    { deleteLegacy: true, state: alreadyPreparedState, touchContacts: false },
  );
});

await test('all modes are idempotent after legacy relationships are gone', () => {
  for (const mode of [prepareMode, verifyMode, finalizeMode] as const) {
    assert.deepEqual(planContactsAuthorizationContext(mode, [], legacyRelationships), {
      deleteLegacy: false,
      state: 'already_finalized',
      touchContacts: false,
    });
  }
});

await test('verify and finalize fail closed when Contacts relationships are missing', () => {
  for (const mode of [verifyMode, finalizeMode] as const) {
    assert.throws(
      () => planContactsAuthorizationContext(mode, legacyRelationships, []),
      /Contacts authorization is missing/u,
    );
  }
});

await test('every mode rejects partial or divergent relationship sets', () => {
  const partial = legacyRelationships.slice(0, 1);
  for (const mode of [prepareMode, verifyMode, finalizeMode] as const) {
    assert.throws(
      () => planContactsAuthorizationContext(mode, legacyRelationships, partial),
      /relationships differ/u,
    );
  }
});
