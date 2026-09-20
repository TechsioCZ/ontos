import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { CommerceEnrollmentAttemptPersistence } from '../../src/enrollment/attempts/attempt-persistence.ts';
import { CommerceEnrollmentAttemptNotFound } from '../../src/enrollment/attempts/errors.ts';
import {
  commerceEnrollmentCompletionAuthorityForPersistence,
  deriveEnrollmentAttemptState,
  enrollmentJourneyDefinitionForAttempt,
} from '../../src/enrollment/orchestration/completion.ts';
import type { EnrollmentTransitionProof } from '../../src/enrollment/orchestration/completion.ts';
import { counterpartyInvitationJourneyDefinition } from '../../src/enrollment/journeys/counterparty-invitation.ts';
import {
  EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS,
  EXISTING_ACCOUNT_OWNERSHIP_TRANSITIONS,
} from '../../src/enrollment/journeys/existing-account.ts';
import type { JourneyDefinition, JourneyTransitionSpec } from '../../src/enrollment/journeys/journey-contracts.ts';
import { journeyTransitionIdentity } from '../../src/enrollment/journeys/journey-contracts.ts';
import {
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
} from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import { retailSelfEnrollmentJourneyDefinition } from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot, EnrollmentOwnerOperationSnapshot } from '../../shared/enrollment-contracts.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentInvitationIdSchema,
  EnrollmentKeySchema,
  EnrollmentModuleKeySchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('11000000-0000-4000-8000-000000000001');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('11000000-0000-4000-8000-000000000002');
const invocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('11000000-0000-4000-8000-000000000003');
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('11000000-0000-4000-8000-000000000004');
const operationId = Schema.decodeSync(EnrollmentOwnerOperationIdSchema)('11000000-0000-4000-8000-000000000005');
const invitationId = Schema.decodeSync(EnrollmentInvitationIdSchema)('11000000-0000-4000-8000-000000000006');
const intentKey = Schema.decodeSync(EnrollmentKeySchema)('completion-intent-1');
const at = DateTime.makeUnsafe('2026-09-18T09:00:00.000Z');

const attempt = (overrides: Partial<EnrollmentAttemptSnapshot> = {}): EnrollmentAttemptSnapshot => ({
  createdAt: at,
  createdByPrincipalId: actorPrincipalId,
  intentDigest: 'c'.repeat(64),
  intentKey,
  journey: 'RETAIL_SELF_ENROLLMENT',
  portalEnrollmentAttemptId: attemptId,
  revision: 1,
  state: 'IN_PROGRESS',
  tenantId,
  updatedAt: at,
  ...overrides,
});

/**
 * Proof is built from the declaration under test rather than from a second copy of the transition
 * keys, so these tests state the completion rule and never restate the journey catalog.
 */
const proven = (transition: JourneyTransitionSpec): EnrollmentTransitionProof => ({
  ownerModuleKey: transition.ownerModuleKey,
  required: true,
  status: 'SUCCEEDED',
  transitionKey: transition.transitionKey,
});

const provenExceptLast = (definition: JourneyDefinition): readonly EnrollmentTransitionProof[] =>
  definition.requiredTransitions.slice(0, -1).map(proven);

const allProven = (definition: JourneyDefinition): readonly EnrollmentTransitionProof[] =>
  definition.requiredTransitions.map(proven);

const lastTransition = (definition: JourneyDefinition): JourneyTransitionSpec => {
  const transition = definition.requiredTransitions.at(-1);
  if (transition === undefined) {
    throw new Error('Every journey declares at least one required transition');
  }
  return transition;
};

const accountCreationIdentity = journeyTransitionIdentity({
  ownerModuleKey: PORTAL_AUTH_OWNER_MODULE_KEY,
  required: true,
  transitionKey: PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
});

/** Everything an Existing-account Attempt may legitimately be gated on: its own steps, and Retail's. */
const existingAccountReachableIdentities = new Set(
  [
    ...EXISTING_ACCOUNT_OWNERSHIP_TRANSITIONS,
    ...EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS,
    ...retailSelfEnrollmentJourneyDefinition.requiredTransitions,
  ].map(journeyTransitionIdentity),
);

/**
 * What composing the Counterparty journey instead would add: the invitation claim, which no
 * deployment registers an owner effect for.
 */
const counterpartyOnlyIdentities = counterpartyInvitationJourneyDefinition.requiredTransitions
  .map(journeyTransitionIdentity)
  .filter((identity) => !existingAccountReachableIdentities.has(identity));

it('holds an Attempt open while any required transition of its journey is unproven', () => {
  for (const definition of [retailSelfEnrollmentJourneyDefinition, counterpartyInvitationJourneyDefinition]) {
    expect(definition.requiredTransitions.length).toBeGreaterThan(1);
    expect(
      deriveEnrollmentAttemptState({
        definition,
        outcomeStatus: 'SUCCEEDED',
        proofs: provenExceptLast(definition),
      }),
    ).toBe('IN_PROGRESS');
    expect(
      deriveEnrollmentAttemptState({ definition, outcomeStatus: 'SUCCEEDED', proofs: allProven(definition) }),
    ).toBe('COMPLETE');
  }
});

it('never completes on a transition an owner claimed as optional', () => {
  const definition = retailSelfEnrollmentJourneyDefinition;
  const proofs = definition.requiredTransitions.map((transition, index) =>
    index === 0 ? { ...proven(transition), required: false } : proven(transition),
  );
  expect(deriveEnrollmentAttemptState({ definition, outcomeStatus: 'SUCCEEDED', proofs })).toBe('IN_PROGRESS');
});

it('never completes on a failed owner outcome, even with every required transition proven', () => {
  const definition = counterpartyInvitationJourneyDefinition;
  expect(deriveEnrollmentAttemptState({ definition, outcomeStatus: 'FAILED', proofs: allProven(definition) })).toBe(
    'IN_PROGRESS',
  );
});

it('lets an unresolved owner effect outrank both progress and completion', () => {
  const definition = counterpartyInvitationJourneyDefinition;
  const indeterminate = allProven(definition).map((proof, index) =>
    index === 0 ? { ...proof, status: 'INDETERMINATE' as const } : proof,
  );
  expect(deriveEnrollmentAttemptState({ definition, outcomeStatus: 'SUCCEEDED', proofs: indeterminate })).toBe(
    'RECONCILIATION_REQUIRED',
  );
  expect(
    deriveEnrollmentAttemptState({
      definition,
      outcomeStatus: 'SUCCEEDED',
      proofs: allProven(definition),
      signal: 'RECONCILIATION_REQUIRED',
    }),
  ).toBe('RECONCILIATION_REQUIRED');
});

it('carries an owner verification signal only while the journey is still open', () => {
  const definition = retailSelfEnrollmentJourneyDefinition;
  expect(
    deriveEnrollmentAttemptState({
      definition,
      outcomeStatus: 'SUCCEEDED',
      proofs: provenExceptLast(definition),
      signal: 'VERIFICATION_REQUIRED',
    }),
  ).toBe('VERIFICATION_REQUIRED');
  expect(
    deriveEnrollmentAttemptState({
      definition,
      outcomeStatus: 'SUCCEEDED',
      proofs: allProven(definition),
      signal: 'VERIFICATION_REQUIRED',
    }),
  ).toBe('COMPLETE');
});

it.effect('gates each journey kind on its own declared required transitions', () =>
  Effect.gen(function* resolveJourneyDefinitions() {
    const retail = yield* enrollmentJourneyDefinitionForAttempt(attempt());
    const counterparty = yield* enrollmentJourneyDefinitionForAttempt(attempt({ journey: 'COUNTERPARTY_INVITATION' }));
    expect(retail).toBe(retailSelfEnrollmentJourneyDefinition);
    expect(counterparty).toBe(counterpartyInvitationJourneyDefinition);

    // Existing-account never creates a provider account, so it inherits every other required step
    // of the Retail target and adds the second Tenant's own Principal Auth Binding steps.
    const definition = yield* enrollmentJourneyDefinitionForAttempt(attempt({ journey: 'EXISTING_ACCOUNT' }));
    const identities = definition.requiredTransitions.map(journeyTransitionIdentity);
    expect(definition.kind).toBe('EXISTING_ACCOUNT');
    expect(new Set(identities).size).toBe(identities.length);
    for (const coreTransition of EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS) {
      expect(identities).toContain(journeyTransitionIdentity(coreTransition));
    }
    // The account-creation step is replaced by the proof that the caller owns the account it is
    // continuing; without that step the journey would gate on nothing this route can establish.
    for (const ownershipTransition of EXISTING_ACCOUNT_OWNERSHIP_TRANSITIONS) {
      expect(identities).toContain(journeyTransitionIdentity(ownershipTransition));
    }
    expect(identities).not.toContain(accountCreationIdentity);
    for (const inherited of retailSelfEnrollmentJourneyDefinition.requiredTransitions.filter(
      (transition) => journeyTransitionIdentity(transition) !== accountCreationIdentity,
    )) {
      expect(identities).toContain(journeyTransitionIdentity(inherited));
    }
    expect(
      deriveEnrollmentAttemptState({ definition, outcomeStatus: 'SUCCEEDED', proofs: provenExceptLast(definition) }),
    ).toBe('IN_PROGRESS');
    expect(
      deriveEnrollmentAttemptState({ definition, outcomeStatus: 'SUCCEEDED', proofs: allProven(definition) }),
    ).toBe('COMPLETE');
  }),
);

it.effect('never gates an Existing-account Attempt on the Counterparty invitation claim', () =>
  Effect.gen(function* existingAccountIgnoresAnInvitationId() {
    // A durable Attempt of some other journey that carries an invitation id — the start boundary
    // refuses to create one now, and this is what such a row would compose if it existed.
    const definition = yield* enrollmentJourneyDefinitionForAttempt(
      attempt({ invitationId, journey: 'EXISTING_ACCOUNT' }),
    );
    const identities = definition.requiredTransitions.map(journeyTransitionIdentity);

    // Selecting the Counterparty target on the presence of an invitation id gates this Attempt on
    // the invitation claim, which no deployment registers an owner effect for: the Attempt journals
    // its ownership proof, reserves a Core binding and then halts at NO_OWNER_EFFECT for good.
    expect(counterpartyOnlyIdentities.length).toBeGreaterThan(0);
    for (const counterpartyIdentity of counterpartyOnlyIdentities) {
      expect(identities).not.toContain(counterpartyIdentity);
    }
    expect(definition).toStrictEqual(
      yield* enrollmentJourneyDefinitionForAttempt(attempt({ journey: 'EXISTING_ACCOUNT' })),
    );
  }),
);

const existingAccountOwnershipTransition = (): JourneyTransitionSpec => {
  const [transition] = EXISTING_ACCOUNT_OWNERSHIP_TRANSITIONS;
  if (transition === undefined) {
    throw new Error('Existing-account declares an account-ownership transition of its own');
  }
  return transition;
};

it.effect('never completes an Existing-account Attempt whose account-ownership proof is unproven', () =>
  Effect.gen(function* ownershipGatesExistingAccountCompletion() {
    const definition = yield* enrollmentJourneyDefinitionForAttempt(attempt({ journey: 'EXISTING_ACCOUNT' }));
    const ownership = existingAccountOwnershipTransition();
    const ownershipIdentity = journeyTransitionIdentity(ownership);
    const everythingElse = definition.requiredTransitions
      .filter((transition) => journeyTransitionIdentity(transition) !== ownershipIdentity)
      .map(proven);
    expect(everythingElse.length).toBe(definition.requiredTransitions.length - 1);

    // Every other declared step succeeded. Without the ownership proof the Attempt has bound an
    // account to a second Tenant on nobody's authority, so it must not read as a finished journey.
    expect(deriveEnrollmentAttemptState({ definition, outcomeStatus: 'SUCCEEDED', proofs: everythingElse })).toBe(
      'IN_PROGRESS',
    );
    expect(
      deriveEnrollmentAttemptState({
        definition,
        outcomeStatus: 'SUCCEEDED',
        proofs: [...everythingElse, proven(ownership)],
      }),
    ).toBe('COMPLETE');
  }),
);

const journalRow = (transition: JourneyTransitionSpec, status: EnrollmentOwnerOperationSnapshot['status']) => ({
  actorPrincipalId,
  createdAt: at,
  ownerInvocationId: invocationId,
  ownerModuleKey: Schema.decodeSync(EnrollmentModuleKeySchema)(transition.ownerModuleKey),
  portalEnrollmentAttemptId: attemptId,
  portalEnrollmentOwnerOperationId: operationId,
  requestDigest: 'd'.repeat(64),
  required: true,
  revision: 1,
  status,
  tenantId,
  transitionKey: Schema.decodeSync(EnrollmentTransitionKeySchema)(transition.transitionKey),
  updatedAt: at,
});

/** A journal that knows only the transitions listed, exactly as PostgreSQL would report it. */
const journalledPersistence = (
  journal: ReadonlyMap<JourneyTransitionSpec, EnrollmentOwnerOperationSnapshot['status']>,
  read: string[],
): CommerceEnrollmentAttemptPersistence => {
  const missing = () =>
    Effect.fail(
      new CommerceEnrollmentAttemptNotFound({
        attemptId,
        code: 'attempt_not_found',
        reason: 'The Enrollment Attempt owner transition was not found',
        retryable: false,
      }),
    );
  const entryFor = (transitionKey: string) =>
    [...journal].find(([transition]) => transition.transitionKey === transitionKey);
  return {
    authorizeAccountCreation: () => missing(),
    claim: () => missing(),
    create: () => missing(),
    listStale: () => missing(),
    read: () => Effect.succeed(attempt()),
    readOperation: (input) => {
      read.push(input.transitionKey);
      const entry = entryFor(input.transitionKey);
      return entry === undefined ? missing() : Effect.succeed(journalRow(entry[0], entry[1]));
    },
    readOperations: () =>
      Effect.succeed(
        [...journal].map(([transition, status]) => {
          read.push(transition.transitionKey);
          return journalRow(transition, status);
        }),
      ),
    reconcile: () => missing(),
    record: () => missing(),
    terminate: () => missing(),
  };
};

it.effect('reads the durable journal, not the request, to decide whether an Attempt is complete', () =>
  Effect.gen(function* deriveFromJournal() {
    const definition = retailSelfEnrollmentJourneyDefinition;
    const pending = lastTransition(definition);
    const read: string[] = [];
    // Every required transition but the pending one already succeeded; the pending row is still
    // IN_PROGRESS in the journal because its outcome has not been written yet.
    const journal = new Map(
      definition.requiredTransitions.map((transition) => [
        transition,
        transition === pending ? ('IN_PROGRESS' as const) : ('SUCCEEDED' as const),
      ]),
    );
    const authority = commerceEnrollmentCompletionAuthorityForPersistence(journalledPersistence(journal, read));
    const outcome = {
      ownerModuleKey: pending.ownerModuleKey,
      status: 'SUCCEEDED' as const,
      transitionKey: pending.transitionKey,
    };
    expect(yield* authority.derive(attempt(), outcome)).toBe('COMPLETE');
    expect(read).toEqual(definition.requiredTransitions.map((transition) => transition.transitionKey));
    expect(yield* authority.derive(attempt(), { ...outcome, status: 'FAILED' })).toBe('IN_PROGRESS');
  }),
);

it.effect('derives an Existing-account Attempt from a journal that carries its ownership proof', () =>
  Effect.gen(function* deriveExistingAccountFromJournal() {
    const existingAccount = attempt({ journey: 'EXISTING_ACCOUNT' });
    const definition = yield* enrollmentJourneyDefinitionForAttempt(existingAccount);
    const pending = lastTransition(definition);
    const journalled = (rows: readonly JourneyTransitionSpec[]) =>
      commerceEnrollmentCompletionAuthorityForPersistence(
        journalledPersistence(
          new Map(
            rows.map((transition) => [
              transition,
              transition === pending ? ('IN_PROGRESS' as const) : ('SUCCEEDED' as const),
            ]),
          ),
          [],
        ),
      );
    const outcome = {
      ownerModuleKey: pending.ownerModuleKey,
      status: 'SUCCEEDED' as const,
      transitionKey: pending.transitionKey,
    };
    const ownershipIdentity = journeyTransitionIdentity(existingAccountOwnershipTransition());

    // A journal missing only the ownership row cannot complete; the very same journal with that one
    // row present does. The ownership proof is therefore counted, not merely declared.
    expect(
      yield* journalled(
        definition.requiredTransitions.filter(
          (transition) => journeyTransitionIdentity(transition) !== ownershipIdentity,
        ),
      ).derive(existingAccount, outcome),
    ).toBe('IN_PROGRESS');
    expect(yield* journalled(definition.requiredTransitions).derive(existingAccount, outcome)).toBe('COMPLETE');
  }),
);

it.effect('treats a required transition that was never claimed as unproven rather than as a failure', () =>
  Effect.gen(function* deriveWithMissingJournalRow() {
    const definition = retailSelfEnrollmentJourneyDefinition;
    const [first] = definition.requiredTransitions;
    if (first === undefined) {
      throw new Error('Retail self-enrollment declares required transitions');
    }
    const authority = commerceEnrollmentCompletionAuthorityForPersistence(
      journalledPersistence(new Map([[first, 'IN_PROGRESS' as const]]), []),
    );
    const state = yield* authority.derive(attempt(), {
      ownerModuleKey: first.ownerModuleKey,
      status: 'SUCCEEDED',
      transitionKey: first.transitionKey,
    });
    expect(state).toBe('IN_PROGRESS');
  }),
);
