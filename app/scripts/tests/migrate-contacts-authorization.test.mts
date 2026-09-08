import { expect, it } from 'effect-rstest';
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

it('prepare creates Contacts relationships from a legacy-only context', () => {
  expect(planContactsAuthorizationContext(prepareMode, legacyRelationships, [])).toEqual({
    deleteLegacy: false,
    state: 'legacy_only',
    touchContacts: true,
  });
});

it('prepare and verify accept an exactly prepared context', () => {
  const reordered = [legacyRelationships[1], legacyRelationships[0]] as const;
  expect(planContactsAuthorizationContext(prepareMode, legacyRelationships, reordered).state).toBe(
    alreadyPreparedState,
  );
  expect(planContactsAuthorizationContext(verifyMode, legacyRelationships, reordered).state).toBe(
    alreadyPreparedState,
  );
});

it('finalize removes only an exactly matched legacy context', () => {
  expect(
    planContactsAuthorizationContext(finalizeMode, legacyRelationships, legacyRelationships),
  ).toEqual({ deleteLegacy: true, state: alreadyPreparedState, touchContacts: false });
});

it('all modes are idempotent after legacy relationships are gone', () => {
  for (const mode of [prepareMode, verifyMode, finalizeMode] as const) {
    expect(planContactsAuthorizationContext(mode, [], legacyRelationships)).toEqual({
      deleteLegacy: false,
      state: 'already_finalized',
      touchContacts: false,
    });
  }
});

it('verify and finalize fail closed when Contacts relationships are missing', () => {
  for (const mode of [verifyMode, finalizeMode] as const) {
    expect(() => planContactsAuthorizationContext(mode, legacyRelationships, [])).toThrow(
      /Contacts authorization is missing/u,
    );
  }
});

it('every mode rejects partial or divergent relationship sets', () => {
  const partial = legacyRelationships.slice(0, 1);
  for (const mode of [prepareMode, verifyMode, finalizeMode] as const) {
    expect(() => planContactsAuthorizationContext(mode, legacyRelationships, partial)).toThrow(
      /relationships differ/u,
    );
  }
});
