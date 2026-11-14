import { DateTime, Effect } from 'effect';

/** The exclusive window the production resolver gives an ELIGIBLE Counterparty customer-role observation. */
const ROLE_OBSERVATION_WINDOW_SECONDS = 30;

/**
 * A TEST Counterparty customer-role answer observed the way the production resolver observes one: an ELIGIBLE
 * role carries the instant it was read and is usable for at most 30 seconds after it, so the prepared-role
 * currentness check treats it exactly like owner evidence.
 */
export const observedEligibleCounterpartyRole = Effect.fn('TestCounterpartyRole.observeEligible')(
  function* observeEligible(role: {
    readonly managedLegalEntityId: string;
    readonly roleResourceId: string;
    readonly roleResourceRevision: string;
  }) {
    const observed = yield* DateTime.now;
    return {
      ...role,
      observedAt: DateTime.formatIso(observed),
      outcome: 'ELIGIBLE' as const,
      validUntil: DateTime.formatIso(DateTime.add(observed, { seconds: ROLE_OBSERVATION_WINDOW_SECONDS })),
    };
  },
);
