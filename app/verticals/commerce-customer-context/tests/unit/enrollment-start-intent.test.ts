import { randomUUID } from 'node:crypto';

import { Effect, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CommercePortalAuthEnrollmentStartInputSchema } from '../../api/portal-auth/enrollment/contracts.ts';
import { commercePortalAuthEnrollmentCreatesAccount } from '../../api/portal-auth/enrollment/http.ts';
import { commercePortalAuthEnrollmentIntent } from '../../api/portal-auth/enrollment/intent.ts';
import { existingAccountJourneyDefinitionFor } from '../../src/enrollment/journeys/existing-account.ts';
import type { JourneyDefinition } from '../../src/enrollment/journeys/journey-contracts.ts';
import { retailSelfEnrollmentJourneyDefinition } from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import {
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
} from '../../src/enrollment/orchestration/prepared-owner-authority.ts';

/**
 * The start boundary: what a caller may name, and what the Attempt identity derived from it is.
 *
 * `portal_enrollment_attempts` is unique on `(tenant_id, intent_key)`, so the key these derivations
 * produce is the row identity of every enrollment in a Tenant. These scenarios pin the two things
 * that makes safe: unrelated people never derive the same key, and one person's retry always does.
 */

const SELLING_LEGAL_ENTITY_ID = randomUUID();

/**
 * A start request body as it reaches the handler, wide enough to express the combinations the
 * payload schema is meant to refuse: any journey, with or without an invitation.
 */
interface EnrollmentStartRequestBody {
  readonly displayName: string;
  readonly email: string;
  readonly invitationId?: string;
  readonly journey: string;
  readonly password: Redacted.Redacted;
  readonly sellingLegalEntityId: string;
}

const startPayload = (
  overrides: Partial<EnrollmentStartRequestBody> & { readonly journey: string },
): EnrollmentStartRequestBody => ({
  displayName: 'Enrollment start intent',
  email: 'first.person@example.test',
  // The credential is `Redacted` from the transport boundary inward; nothing below ever sees it.
  password: Redacted.make('P'.repeat(24)),
  sellingLegalEntityId: SELLING_LEGAL_ENTITY_ID,
  ...overrides,
});

const decodeStart = (payload: EnrollmentStartRequestBody) =>
  Schema.decodeUnknownEffect(CommercePortalAuthEnrollmentStartInputSchema)(payload);

const intentFor = (payload: EnrollmentStartRequestBody) =>
  decodeStart(payload).pipe(Effect.flatMap(commercePortalAuthEnrollmentIntent));

const declaresAccountCreation = (definition: JourneyDefinition): boolean =>
  definition.requiredTransitions.some(
    (transition) =>
      transition.ownerModuleKey === PORTAL_AUTH_OWNER_MODULE_KEY &&
      transition.transitionKey === PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  );

it.effect('two people enrolling into one Tenant never derive the same Attempt identity', () =>
  Effect.gen(function* twoPeopleNeverCollide() {
    const first = yield* intentFor(startPayload({ journey: 'RETAIL_SELF_ENROLLMENT' }));
    const second = yield* intentFor(
      startPayload({ email: 'second.person@example.test', journey: 'RETAIL_SELF_ENROLLMENT' }),
    );

    // A key naming only the journey is identical for both, and the durable unique index on
    // `(tenant_id, intent_key)` then either rejects the second person or converges them onto the
    // first person's Attempt. Removing the identity from the key fails exactly here.
    expect(first.intentKey).not.toBe(second.intentKey);
    expect(first.intentDigest).not.toBe(second.intentDigest);
  }),
);

it.effect('the same person retrying converges on one Attempt identity', () =>
  Effect.gen(function* retryConverges() {
    const first = yield* intentFor(startPayload({ journey: 'RETAIL_SELF_ENROLLMENT' }));
    // The same person, presenting the address differently and correcting the credential: the
    // identity is the normalized address, and neither the password nor the display name is in it.
    const retry = yield* intentFor(
      startPayload({
        displayName: 'Corrected display name',
        email: 'First.Person@Example.TEST',
        journey: 'RETAIL_SELF_ENROLLMENT',
        password: Redacted.make('Q'.repeat(24)),
      }),
    );

    expect(retry.intentKey).toBe(first.intentKey);
    expect(retry.intentDigest).toBe(first.intentDigest);
  }),
);

it.effect('an invitation enrollment is identified by the invitation it claims', () =>
  Effect.gen(function* invitationKeyedByInvitation() {
    const invitationId = randomUUID();
    const claimed = yield* intentFor(startPayload({ invitationId, journey: 'COUNTERPARTY_INVITATION' }));
    // The same invitation presented with a different address is the same enrollment; a different
    // invitation is a different one even from the same address.
    const sameInvitation = yield* intentFor(
      startPayload({ email: 'someone.else@example.test', invitationId, journey: 'COUNTERPARTY_INVITATION' }),
    );
    const otherInvitation = yield* intentFor(
      startPayload({ invitationId: randomUUID(), journey: 'COUNTERPARTY_INVITATION' }),
    );

    expect(sameInvitation.intentKey).toBe(claimed.intentKey);
    expect(otherInvitation.intentKey).not.toBe(claimed.intentKey);
  }),
);

it.effect('the two journeys keep separate Attempt identities for one address', () =>
  Effect.gen(function* journeysStaySeparate() {
    const retail = yield* intentFor(startPayload({ journey: 'RETAIL_SELF_ENROLLMENT' }));
    const existing = yield* intentFor(startPayload({ journey: 'EXISTING_ACCOUNT' }));

    expect(existing.intentKey).not.toBe(retail.intentKey);
  }),
);

it.effect('a Retail self-enrollment that names an invitation is refused at decode', () =>
  Effect.gen(function* retailNamingAnInvitation() {
    const named = startPayload({ invitationId: randomUUID(), journey: 'RETAIL_SELF_ENROLLMENT' });
    const failure = yield* Effect.flip(decodeStart(named));

    // Rejected by the payload schema itself, so no Action runs and no provider mutation is reached.
    expect(Predicate.isTagged(failure, 'SchemaError')).toBe(true);
    // The very same payload without the invitation decodes, so the refusal is about that key alone.
    expect((yield* decodeStart(startPayload({ journey: 'RETAIL_SELF_ENROLLMENT' }))).journey).toBe(
      'RETAIL_SELF_ENROLLMENT',
    );
  }),
);

it.effect('a Counterparty invitation enrollment that names no invitation is refused at decode', () =>
  Effect.gen(function* invitationWithoutAnInvitation() {
    const unnamed = startPayload({ journey: 'COUNTERPARTY_INVITATION' });
    const failure = yield* Effect.flip(decodeStart(unnamed));

    expect(Predicate.isTagged(failure, 'SchemaError')).toBe(true);
    // Adding the invitation it claims is the only thing missing.
    expect((yield* decodeStart({ ...unnamed, invitationId: randomUUID() })).journey).toBe('COUNTERPARTY_INVITATION');
  }),
);

it.effect('Existing-account enrollment may still name the invitation it is entering through', () =>
  Effect.gen(function* existingAccountKeepsItsInvitation() {
    const invitationId = randomUUID();
    const intent = yield* intentFor(startPayload({ invitationId, journey: 'EXISTING_ACCOUNT' }));

    expect(intent.invitationId).toBe(invitationId);
  }),
);

it.effect('start creates a provider account exactly for the journeys that declare one', () =>
  Effect.gen(function* startMatchesTheJourneyDeclaration() {
    const existingAccount = yield* existingAccountJourneyDefinitionFor(retailSelfEnrollmentJourneyDefinition);

    // The route's own rule, checked against what each journey it starts declares. Claiming account
    // creation for Existing-account gates its Attempt on a transition its definition removed, so
    // that Attempt can never be advanced — which is what this pairing refuses to allow. The
    // Counterparty invitation journey is absent because start refuses it outright; see the 422 in
    // `tests/integration/enrollment-journeys-http.test.ts`.
    expect(commercePortalAuthEnrollmentCreatesAccount('RETAIL_SELF_ENROLLMENT')).toBe(
      declaresAccountCreation(retailSelfEnrollmentJourneyDefinition),
    );
    expect(declaresAccountCreation(retailSelfEnrollmentJourneyDefinition)).toBe(true);
    expect(commercePortalAuthEnrollmentCreatesAccount('EXISTING_ACCOUNT')).toBe(
      declaresAccountCreation(existingAccount),
    );
    expect(declaresAccountCreation(existingAccount)).toBe(false);
  }),
);
