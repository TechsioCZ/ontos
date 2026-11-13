/* eslint-disable anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The test harness decodes fixture rows through each owner routine schema before exposing Core's private branded transaction capability; expires: 2027-03-31. */
import type { OwnerAuthorizationInput, ScopedRoutineDefinition, ScopedTransactionExecutor } from '@app/core-runtime';
import { DateTime, Deferred, Effect, Fiber, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ownerAuthorizationFromExit } from '@app/core-runtime';
import { makeCommerceCustomerContextOwnerAuthorizationOverlay } from '../../src/persistence/owner-authorization-overlay.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const principalId = '50000000-0000-4000-8000-000000000001';
const counterpartyId = 'counterparty-one';
const operationAt = DateTime.makeUnsafe(new Date('2026-09-09T09:00:00.000Z'));

const scope = Object.freeze({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:owner-overlay-test',
  authMethod: 'session' as const,
  correlationId: 'owner-overlay-correlation',
  legalEntityId,
  principalId,
  tenantId,
  trustedStorefrontId: 'storefront-one',
});

const ownerRow = (state: 'ACTIVE' | 'REVOKED', storefrontResourceId: string | null = null) => ({
  counterparty_resource_id: counterpartyId,
  grant_id: '70000000-0000-4000-8000-000000000001',
  granted_at: '2026-09-09T09:00:00.000Z',
  granted_by: principalId,
  permission_code: 'counterparty.access.manage',
  principal_id: principalId,
  reason: 'Owner overlay test',
  revision: 2,
  revoked_at: state === 'REVOKED' ? '2026-09-09T09:01:00.000Z' : null,
  revoked_by: state === 'REVOKED' ? principalId : null,
  state,
  storefront_resource_id: storefrontResourceId,
});

type RoutineHandler = (routineKey: string, values: readonly unknown[]) => readonly object[];

const transactionWith = (handler: RoutineHandler): ScopedTransactionExecutor =>
  // SAFETY: Every fixture row is decoded by the invoked owner routine schema; this harness only
  // exercises the adapter's scoped `invoke` capability.
  ({
    invoke: (routine: ScopedRoutineDefinition, values: readonly unknown[] = []) =>
      Effect.sync(() => handler(routine.routineKey, values)).pipe(
        Effect.flatMap((rows) =>
          // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach's second argument is the element effect, not Array thisArg.
          Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(routine.resultSchema)(row)),
        ),
      ),
  }) as unknown as ScopedTransactionExecutor;

const transactionWithEffect = (
  handler: (routineKey: string) => Effect.Effect<readonly object[]>,
): ScopedTransactionExecutor =>
  // SAFETY: Every fixture row is decoded by the invoked owner routine schema; this harness only
  // exercises the adapter's scoped `invoke` capability.
  ({
    invoke: (routine: ScopedRoutineDefinition) =>
      handler(routine.routineKey).pipe(
        Effect.flatMap((rows) =>
          // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach's second argument is the element effect, not Array thisArg.
          Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(routine.resultSchema)(row)),
        ),
      ),
  }) as unknown as ScopedTransactionExecutor;

const factInput = (operationKey: string, ownerFacts?: Readonly<Record<string, string>>): OwnerAuthorizationInput => {
  const base: OwnerAuthorizationInput = {
    capabilityKey: operationKey,
    operation: 'action',
    operationAt,
    operationKey,
    owningModuleKey: 'commerce.customer-context',
    scope,
    targets: [],
  };
  return ownerFacts === undefined ? base : { ...base, ownerFacts };
};

const grantCounterpartyCommerceAccess = 'commerce.customer-context.grant-counterparty-commerce-access';

/** A refusal names its owner rule and the owner-local right the actor lacks, for the 403 and the log. */
const refused = (...reasons: readonly string[]) => ({ decision: 'denied', reasons });
const accessManageGrantMissing = refused(
  'deny.owner.counterparty_grant_missing',
  'requires.counterparty.access.manage',
);

it.effect('denies once the owner row is revoked', () =>
  Effect.gen(function* ownerRevoked() {
    const calls: string[] = [];
    const transaction = transactionWith((routineKey) => {
      calls.push(routineKey);
      return routineKey === 'counterparty-access.lock-grant-authority' ? [ownerRow('REVOKED')] : [];
    });
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    const decision = yield* overlay.authorize(
      transaction,
      factInput(grantCounterpartyCommerceAccess, { counterpartyId }),
    );

    expect(decision).toEqual(accessManageGrantMissing);
    expect(calls).toEqual(['counterparty-access.lock-grant-authority']);
  }),
);

it.effect('uses a broad active owner row for a narrower storefront fact', () =>
  Effect.gen(function* broadActiveOwnerGrant() {
    const transaction = transactionWith((routineKey) =>
      routineKey === 'counterparty-access.lock-grant-authority'
        ? [ownerRow('ACTIVE'), ownerRow('REVOKED', 'storefront-one')]
        : [],
    );
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    const decision = yield* overlay.authorize(
      transaction,
      factInput(grantCounterpartyCommerceAccess, { counterpartyId, storefrontId: 'storefront-one' }),
    );

    expect(decision).toBe('allowed');
  }),
);

it.effect('fences a grant reauthorization against a concurrent revoke', () =>
  Effect.gen(function* revokeBeforeGrantReauthorization() {
    const lockStarted = yield* Deferred.make<null>();
    const releaseFence = yield* Deferred.make<null>();
    let revokeCommitted = false;
    const transaction = transactionWithEffect((routineKey) => {
      if (routineKey !== 'counterparty-access.lock-grant-authority') {
        return Effect.succeed([]);
      }
      return Effect.gen(function* ownerFence() {
        yield* Deferred.succeed(lockStarted, null);
        yield* Deferred.await(releaseFence);
        return [ownerRow(revokeCommitted ? 'REVOKED' : 'ACTIVE')];
      });
    });
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    const decisionFiber = yield* Effect.forkScoped(
      overlay.authorize(transaction, factInput(grantCounterpartyCommerceAccess, { counterpartyId })),
    );
    yield* Deferred.await(lockStarted);
    revokeCommitted = true;
    yield* Deferred.succeed(releaseFence, null);

    expect(yield* Fiber.join(decisionFiber)).toEqual(accessManageGrantMissing);
  }),
);

/** The real scoped SQL returns rows only for the Counterparty it was asked about. */
const grantRowsFor = (grantedCounterpartyId?: string) => (routineKey: string, values: readonly unknown[]) => {
  if (
    routineKey !== 'counterparty-access.lock-grant-authority' ||
    grantedCounterpartyId === undefined ||
    values[0] !== grantedCounterpartyId
  ) {
    return [];
  }
  return [{ ...ownerRow('ACTIVE'), counterparty_resource_id: grantedCounterpartyId }];
};

it.effect('allows the Counterparty the owner granted and denies a different one (O67-Q1)', () =>
  Effect.gen(function* perCounterpartyGrant() {
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    const granted = yield* overlay.authorize(
      transactionWith(grantRowsFor(counterpartyId)),
      factInput('commerce.customer-context.grant-counterparty-commerce-access', { counterpartyId }),
    );
    const other = yield* overlay.authorize(
      transactionWith(grantRowsFor(counterpartyId)),
      factInput('commerce.customer-context.grant-counterparty-commerce-access', { counterpartyId: 'counterparty-two' }),
    );

    expect(granted).toBe('allowed');
    expect(other).toEqual(accessManageGrantMissing);
  }),
);

/**
 * Every counterparty-governed read the owner's catalogue does not publish (R5b-1). Each names the
 * owner-local Counterparty Permission the overlay must apply to its Counterparty fact; an unmapped
 * operation is denied, so this table is the spec the overlay is held to.
 */
const UNPUBLISHED_COUNTERPARTY_READ_PERMISSIONS = [
  ['commerce.customer-context.api.customer-payment-term-entitlement-read', 'counterparty.profile.read'],
  ['commerce.customer-context.api.payment-terms-resolution', 'counterparty.profile.read'],
  ['commerce.customer-context.api.customer-price-group-assignment-read', 'counterparty.profile.read'],
  ['commerce.customer-context.api.customer-price-group-resolution', 'counterparty.profile.read'],
  ['commerce.customer-context.api.order-commitment-approval-evidence', 'counterparty.purchase.submit'],
] as const;

it.effect('denies a Counterparty-governed read whose fact names a different Counterparty (R5b-1)', () =>
  Effect.gen(function* buyerATargetB() {
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    for (const [operationKey, permission] of UNPUBLISHED_COUNTERPARTY_READ_PERMISSIONS) {
      // The buyer holds a grant only for counterparty A; the request names B, so the owner rule
      // must refuse rather than fall through to the scope-wide capability.
      const decision = yield* overlay.authorize(
        transactionWith(grantRowsFor(counterpartyId)),
        factInput(operationKey, { counterpartyId: 'counterparty-two' }),
      );
      expect(decision).toEqual(refused('deny.owner.counterparty_grant_missing', `requires.${permission}`));
    }
  }),
);

it.effect('admits a Counterparty-governed read only with the exact owner permission (R5b-1)', () =>
  Effect.gen(function* exactOwnerPermission() {
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    for (const [operationKey, permission] of UNPUBLISHED_COUNTERPARTY_READ_PERMISSIONS) {
      const rowsWith = (permissionCode: string) => () => [{ ...ownerRow('ACTIVE'), permission_code: permissionCode }];
      const granted = yield* overlay.authorize(
        transactionWith(rowsWith(permission)),
        factInput(operationKey, { counterpartyId }),
      );
      const wrongPermission = yield* overlay.authorize(
        transactionWith(rowsWith('counterparty.access.manage')),
        factInput(operationKey, { counterpartyId }),
      );
      expect(granted).toBe('allowed');
      expect(wrongPermission).toEqual(refused('deny.owner.counterparty_grant_missing', `requires.${permission}`));
    }
  }),
);

it.effect('denies an unmapped operation that carries a Counterparty fact (R5b-1 default case)', () =>
  Effect.gen(function* unmappedCounterpartyOperation() {
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    // A Counterparty fact with no owner permission mapped is never allowed to reach the scope-wide
    // capability (O67-Q1, O70).
    const decision = yield* overlay.authorize(
      transactionWith(grantRowsFor(counterpartyId)),
      factInput('commerce.customer-context.api.some-unmapped-counterparty-read', { counterpartyId }),
    );
    expect(decision).toEqual(refused('deny.owner.operation_unmapped'));
  }),
);

it.effect('denies a Counterparty capability whose descriptor declares no owner facts', () =>
  Effect.gen(function* missingFactResolver() {
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    const noFact = yield* overlay.authorize(
      transactionWith(() => []),
      factInput('commerce.customer-context.grant-counterparty-commerce-access'),
    );
    const noRow = yield* overlay.authorize(
      transactionWith(grantRowsFor()),
      factInput('commerce.customer-context.grant-counterparty-commerce-access', { counterpartyId }),
    );

    expect(noFact).toEqual(refused('deny.owner.facts_missing', 'requires.counterparty.access.manage'));
    expect(noRow).toEqual(accessManageGrantMissing);
  }),
);

it.effect('denies a Counterparty capability whose fact bag names no Counterparty', () =>
  Effect.gen(function* malformedFactBag() {
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    const storefrontOnly = yield* overlay.authorize(
      transactionWith(grantRowsFor(counterpartyId)),
      factInput('commerce.customer-context.grant-counterparty-commerce-access', { storefrontId: 'storefront-one' }),
    );

    expect(storefrontOnly).toEqual(refused('deny.owner.facts_unrecognized'));
  }),
);

it.effect('leaves a declared but empty fact bag owner-neutral for a guest resolution', () =>
  Effect.gen(function* guestResolution() {
    const calls: string[] = [];
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    const decision = yield* overlay.authorize(
      transactionWith((routineKey) => {
        calls.push(routineKey);
        return [];
      }),
      factInput('commerce.customer-context.api.invoice-recipient-resolution', {}),
    );

    // The owner declared the request names no Counterparty record; the v2 gate and the read
    // handler own it, so the overlay stays neutral and never guesses a Counterparty (O70).
    expect(decision).toBe('allowed');
    expect(calls).toEqual([]);
  }),
);

it.effect('leaves a capability without owner-governed Counterparty authority to the v2 gate', () =>
  Effect.gen(function* capabilityOnly() {
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    const decision = yield* overlay.authorize(
      transactionWith(() => []),
      factInput('commerce.customer-context.test.ungoverned-capability'),
    );

    expect(decision).toBe('allowed');
  }),
);

it.effect('denies a Retail capability whose profile fact or retail permission is missing', () =>
  Effect.gen(function* retailFactsRequired() {
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    const profileOnly = yield* overlay.authorize(
      transactionWith(() => []),
      factInput('commerce.customer-context.api.retail-access-decision', { retailProfileId: 'profile-one' }),
    );
    const permissionOnly = yield* overlay.authorize(
      transactionWith(() => []),
      factInput('commerce.customer-context.api.retail-access-decision', { retailPermission: 'retail.profile.read' }),
    );
    const unboundProfile = yield* overlay.authorize(
      transactionWith(() => []),
      factInput('commerce.customer-context.api.retail-access-decision', {
        retailPermission: 'retail.profile.read',
        retailProfileId: 'profile-one',
      }),
    );

    expect(profileOnly).toEqual(refused('deny.owner.retail_fact_missing'));
    expect(permissionOnly).toEqual(refused('deny.owner.retail_fact_missing'));
    // The owner profile has no binding for this principal: the durable owner state is unavailable,
    // which is a 503 and never an allow (fail closed, O48).
    expect(unboundProfile).toBe('unavailable');
  }),
);

/** One portal session's facts: its binding, its customer principal, its provider subject and the Party it names. */
const portalSession = {
  portalAuthBindingId: '60000000-0000-4000-8000-000000000001',
  portalCustomerPrincipalId: '60000000-0000-4000-8000-000000000002',
  portalPartyId: '60000000-0000-4000-8000-000000000003',
  portalProviderSubjectId: 'customer-subject-one',
};
const boundProfileId = '60000000-0000-4000-8000-000000000004';
/** The owner's own account mapping: which Party (and profile) this session's account is bound to here. */
const accountBoundTo = (partyId: string) => (routineKey: string) =>
  routineKey === 'portal-enrollment.account-party.read' ? [{ party_id: partyId, profile_id: boundProfileId }] : [];
/** Each portal operation and the retail right its session's account must hold (the operation chooses it). */
const PORTAL_OPERATIONS = [
  ['commerce.customer-context.api.customer-profile-read-own', 'retail.profile.read'],
  ['commerce.customer-context.update-own-customer-profile', 'retail.profile.read'],
  ['commerce.customer-context.api.customer-consent-read-own', 'retail.consent.manage'],
  ['commerce.customer-context.update-own-customer-consent', 'retail.consent.manage'],
  ['commerce.customer-context.change-own-customer-password', 'retail.profile.read'],
] as const;

it.effect('a portal operation is refused without its full session facts, whatever else it carries', () =>
  Effect.gen(function* portalFactsRequired() {
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    for (const [operation, right] of PORTAL_OPERATIONS) {
      const { portalPartyId: _party, ...withoutParty } = portalSession;
      const factBags: readonly (Readonly<Record<string, string>> | undefined)[] = [
        undefined,
        {},
        withoutParty,
        { counterpartyId },
      ];
      for (const facts of factBags) {
        const answer = yield* overlay.authorize(
          transactionWith(accountBoundTo(portalSession.portalPartyId)),
          factInput(operation, facts),
        );
        expect(answer).toEqual(refused('deny.owner.portal_session_fact_missing', `requires.${right}`));
      }
    }
  }),
);

it.effect("a portal session reaches only the Party its own account is bound to: never another customer's", () =>
  Effect.gen(function* portalPartyIsTheSession() {
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    const otherCustomersParty = '60000000-0000-4000-8000-0000000000ff';
    for (const [operation, right] of PORTAL_OPERATIONS) {
      // The session's account is bound to another Party than the request names: refused before any retail check.
      const mismatch = yield* overlay.authorize(
        transactionWith(accountBoundTo(otherCustomersParty)),
        factInput(operation, portalSession),
      );
      expect(mismatch).toEqual(refused('deny.owner.portal_party_mismatch'));
      // The session's account is bound nowhere in this company: refused, naming the right it would need.
      const unbound = yield* overlay.authorize(
        transactionWith(() => []),
        factInput(operation, portalSession),
      );
      expect(unbound).toEqual(refused('deny.owner.portal_session_unbound', `requires.${right}`));
    }
  }),
);

it.effect("a bound portal session still needs its account's own retail right for the operation", () =>
  Effect.gen(function* portalRetailRight() {
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    const notBound = (routineKey: string) => {
      if (routineKey === 'portal-enrollment.account-party.read') {
        return [{ party_id: portalSession.portalPartyId, profile_id: boundProfileId }];
      }
      return routineKey === 'profile.resolve-principal'
        ? [
            {
              outcome: 'RETAIL_PRINCIPAL_NOT_BOUND',
              payload: { observedAt: '2026-09-09T09:00:00.000Z', profileId: boundProfileId, revision: 1 },
            },
          ]
        : [];
    };
    expect(
      yield* overlay.authorize(
        transactionWith(notBound),
        factInput('commerce.customer-context.update-own-customer-consent', portalSession),
      ),
    ).toEqual(refused('deny.owner.retail_binding_not_found', 'requires.retail.consent.manage'));
    expect(
      yield* overlay.authorize(
        transactionWith(notBound),
        factInput('commerce.customer-context.change-own-customer-password', portalSession),
      ),
    ).toEqual(refused('deny.owner.retail_binding_not_found', 'requires.retail.profile.read'));
  }),
);

it.effect('an unreadable account mapping is unavailable, never an allow', () =>
  Effect.gen(function* portalUnavailable() {
    const overlay = makeCommerceCustomerContextOwnerAuthorizationOverlay();
    const input = factInput('commerce.customer-context.api.customer-profile-read-own', portalSession);
    // As Core decodes the overlay's answer: a crash of the owner state read is unavailable.
    const exit = yield* Effect.exit(
      overlay.authorize(
        transactionWithEffect(() => Effect.die(new Error('owner state unreadable'))),
        input,
      ),
    );
    expect(yield* ownerAuthorizationFromExit(input)(exit)).toEqual({ decision: 'unavailable' });
  }),
);
