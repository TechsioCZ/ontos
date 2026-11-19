import { Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationRequirednessUnknown } from '../../src/domain/catalog/required-errors.ts';
import {
  requiredOutcomeOf,
  RequiredCommunicationNotPrepared,
  requireCommunicationPrepared,
} from '../../src/domain/catalog/required-outcome.ts';
import {
  decideOrThrow,
  FIXTURE_CLOSED_STATE,
  FIXTURE_ORIGINAL_ROLE,
  FIXTURE_SECONDARY_ROLE,
  fixtureContext,
  fixtureRegistry,
  fixtureRequest,
  fixtureType,
  recipient,
  requiredTwoSlotTypeWith,
} from './support/catalog-fixtures.ts';
import { requiredSummary } from './support/summaries.ts';

const registry = fixtureRegistry(fixtureType(), requiredTwoSlotTypeWith());
const requiredRequest = fixtureRequest({ purpose: 'fixture.paired' });
const original = recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original');
const secondary = recipient(FIXTURE_SECONDARY_ROLE, 'contact-secondary');

const decisionFor = (...recipients: Parameters<typeof fixtureContext>[0]) =>
  decideOrThrow(registry, requiredRequest, fixtureContext(recipients));
const outcomeFor = (...recipients: Parameters<typeof fixtureContext>[0]) =>
  requiredSummary(requiredOutcomeOf(decisionFor(...recipients)));

describe('#1394 Rule: a required message does not replace the source business decision', () => {
  it('Scenario: a required message cannot be safely prepared (AC-05)', () => {
    const outcome = outcomeFor();

    // A truthful failed result for the source workflow; it carries no rollback, cancel or resend instruction.
    expect(outcome).toMatchObject({
      kind: 'Failed',
      partial: false,
      preparedSlots: [],
      sourceImpact: 'SOURCE_OWNER_DECIDES',
    });
    expect(Object.keys(outcome).toSorted()).toEqual(['kind', 'partial', 'preparedSlots', 'reasons', 'sourceImpact']);
  });

  it.effect('Scenario: the source workflow requires communication recovery before its next action', () =>
    Effect.gen(function* sourceRecoveryRequired() {
      const decision = decisionFor(original);
      const failure = yield* Effect.flip(requireCommunicationPrepared(decision));

      // The source owner receives the typed failure and applies its own recovery rule; the request and the
      // occurrence it describes are untouched by Communications.
      expect(failure).toBeInstanceOf(RequiredCommunicationNotPrepared);
      expect(failure).toMatchObject({
        outcome: { reasons: [{ reason: 'RECIPIENT_AUTHORITY_MISSING', slotKey: 'secondary' }] },
      });
      expect(decision.request.occurrence).toEqual(requiredRequest.occurrence);
    }),
  );

  it.effect('a fully prepared required communication passes through unchanged', () =>
    Effect.gen(function* fullyPrepared() {
      const decision = decisionFor(original, secondary);

      expect(yield* requireCommunicationPrepared(decision)).toBe(decision);
      expect(requiredSummary(requiredOutcomeOf(decision))).toEqual({
        kind: 'Prepared',
        preparedSlots: ['primary', 'secondary'],
      });
    }),
  );

  it('Scenario: a required message is inadmissible for one person (partial result)', () => {
    const outcome = outcomeFor(
      original,
      recipient(FIXTURE_SECONDARY_ROLE, 'contact-secondary', 'RECIPIENT_NOT_ELIGIBLE'),
    );

    expect(outcome).toEqual({
      kind: 'Failed',
      partial: true,
      preparedSlots: ['primary'],
      reasons: [{ kind: 'CandidateSuppressed', reason: 'RECIPIENT_NOT_ELIGIBLE', slotKey: 'secondary' }],
      sourceImpact: 'SOURCE_OWNER_DECIDES',
    });
  });

  it('AC-05: required is never an exception to Privacy', () => {
    const outcome = outcomeFor(
      recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original', 'PRIVACY_NOT_ALLOWED'),
      recipient(FIXTURE_SECONDARY_ROLE, 'contact-secondary', 'PRIVACY_INDETERMINATE'),
    );

    expect(outcome).toMatchObject({
      kind: 'Failed',
      partial: false,
      preparedSlots: [],
      reasons: [
        { kind: 'CandidateSuppressed', reason: 'PRIVACY_NOT_ALLOWED' },
        { kind: 'CandidateSuppressed', reason: 'PRIVACY_INDETERMINATE' },
      ],
    });
  });

  it('BR-07: a required type whose approved rule went stale reports why and leaves the source decision to its owner', () => {
    const stale = fixtureRegistry(requiredTwoSlotTypeWith({ status: 'STALE' }));
    const decision = decideOrThrow(stale, requiredRequest, fixtureContext([original, secondary]));

    expect(requiredSummary(requiredOutcomeOf(decision))).toMatchObject({
      kind: 'Failed',
      reasons: [{ kind: 'NoMessage', reason: 'TYPE_STALE' }],
      sourceImpact: 'SOURCE_OWNER_DECIDES',
    });
  });

  it('Scenario: a required slot with an ambiguous recipient fails truthfully and never picks one', () => {
    const outcome = outcomeFor(original, recipient(FIXTURE_ORIGINAL_ROLE, 'contact-other'), secondary);

    expect(outcome).toEqual({
      kind: 'Failed',
      partial: true,
      preparedSlots: ['secondary'],
      reasons: [{ kind: 'SlotUnresolved', reason: 'RECIPIENT_AMBIGUOUS', slotKey: 'primary' }],
      sourceImpact: 'SOURCE_OWNER_DECIDES',
    });
  });

  it.effect('BR-08: a stale source is a stop, not a required-communication failure caused by Communications', () =>
    Effect.gen(function* staleSourceIsNotAFailure() {
      const decision = decideOrThrow(
        registry,
        requiredRequest,
        fixtureContext([original, secondary], { state: FIXTURE_CLOSED_STATE }),
      );

      expect(requiredSummary(requiredOutcomeOf(decision))).toEqual({
        kind: 'SourceStale',
        reason: 'SOURCE_STATE_INELIGIBLE',
      });
      // The source owner caused the change itself, so the channel form raises no failure.
      expect(yield* requireCommunicationPrepared(decision)).toBe(decision);
    }),
  );

  it('BR-06: an optional type owes the source nothing', () => {
    const blocked = recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original', 'PRIVACY_NOT_ALLOWED');
    const optional = decideOrThrow(registry, fixtureRequest(), fixtureContext([blocked]));

    expect(requiredSummary(requiredOutcomeOf(optional))).toEqual({ kind: 'NotRequired' });
  });

  it.effect('an unknown purpose is never a prepared required communication and fails visibly', () =>
    Effect.gen(function* unknownPurposeFails() {
      const unknown = decideOrThrow(registry, fixtureRequest({ purpose: 'fixture.unknown' }), fixtureContext([]));
      const failure = yield* Effect.flip(requireCommunicationPrepared(unknown));

      expect(requiredSummary(requiredOutcomeOf(unknown))).toEqual({ kind: 'RequirednessUnknown' });
      expect(failure).toBeInstanceOf(CommunicationRequirednessUnknown);
      expect(failure).toMatchObject({ purpose: 'fixture.unknown' });
    }),
  );

  it.effect('a type owned by another source is not described to the issuer and fails as unknown', () =>
    Effect.gen(function* foreignTypeIsUnknown() {
      const foreign = decideOrThrow(
        registry,
        fixtureRequest({ moduleKey: 'fixture.other-source', purpose: 'fixture.paired' }),
        fixtureContext([original, secondary]),
      );
      const failure = yield* Effect.flip(requireCommunicationPrepared(foreign));

      expect(failure).toBeInstanceOf(CommunicationRequirednessUnknown);
    }),
  );
});
