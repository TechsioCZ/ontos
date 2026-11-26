import { describe, expect, it } from 'effect-rstest';

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
import { feedOfDecision, feedSummary } from './support/required-feed.ts';

/**
 * The outcome a REQUIRED type owes the source workflow, proven over the ONE derivation production uses
 * (`sourceOutcomeFeedOf`, #1402) from the decision of a request. Required is a business requirement on the OUTCOME: it never
 * bypasses Privacy, recipient or channel stops, never promises delivery, and the source owner alone decides what the result
 * means for its own workflow.
 */
const registry = fixtureRegistry(fixtureType(), requiredTwoSlotTypeWith());
const requiredRequest = fixtureRequest({ purpose: 'fixture.paired' });
const original = recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original');
const secondary = recipient(FIXTURE_SECONDARY_ROLE, 'contact-secondary');

const decisionFor = (...recipients: Parameters<typeof fixtureContext>[0]) =>
  decideOrThrow(registry, requiredRequest, fixtureContext(recipients));
const feedFor = (...recipients: Parameters<typeof fixtureContext>[0]) => feedOfDecision(decisionFor(...recipients));

describe('#1394 Rule: a required message does not replace the source business decision', () => {
  it('Scenario: a required message cannot be safely prepared (AC-05)', () => {
    const feed = feedFor();

    // A truthful failed result for the source workflow; it carries no rollback, cancel or resend instruction.
    expect(feedSummary(feed)).toEqual({
      attentions: [],
      partial: false,
      reasons: [],
      requiredOutcome: 'FAILED',
      sourceImpact: 'SOURCE_OWNER_DECIDES',
    });
    expect(feed.noMessageReason).toBe('RECIPIENT_AUTHORITY_MISSING');
    expect(feed.unresolvedSlots.map(({ slotKey }) => slotKey)).toEqual(['primary', 'secondary']);
  });

  it('Scenario: the source workflow learns which slot could not be prepared and what was prepared anyway', () => {
    const decision = decisionFor(original);
    const feed = feedOfDecision(decision);

    // one message is prepared and the other slot is unresolved: partial, so the source never reads it as all-or-nothing
    expect(feedSummary(feed)).toMatchObject({
      partial: true,
      requiredOutcome: 'FAILED',
      sourceImpact: 'SOURCE_OWNER_DECIDES',
    });
    expect(feed.unresolvedSlots).toEqual([{ reason: 'RECIPIENT_AUTHORITY_MISSING', slotKey: 'secondary' }]);
    // the request and the occurrence it describes are untouched by Communications
    expect(decision.request.occurrence).toEqual(requiredRequest.occurrence);
  });

  it('a fully prepared required communication owes the source nothing yet: in progress, never a delivery claim', () => {
    expect(feedSummary(feedFor(original, secondary))).toEqual({
      attentions: ['IN_PROGRESS', 'IN_PROGRESS'],
      partial: false,
      reasons: [undefined, undefined],
      requiredOutcome: 'IN_PROGRESS',
      sourceImpact: 'SOURCE_OWNER_DECIDES',
    });
  });

  it('Scenario: a required message is inadmissible for one person (partial result)', () => {
    const feed = feedFor(original, recipient(FIXTURE_SECONDARY_ROLE, 'contact-secondary', 'RECIPIENT_NOT_ELIGIBLE'));

    expect(feedSummary(feed)).toEqual({
      attentions: ['IN_PROGRESS', 'FAILURE'],
      partial: true,
      reasons: [undefined, 'RECIPIENT_NOT_ELIGIBLE'],
      requiredOutcome: 'FAILED',
      sourceImpact: 'SOURCE_OWNER_DECIDES',
    });
  });

  it('AC-05: required is never an exception to Privacy', () => {
    const feed = feedFor(
      recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original', 'PRIVACY_NOT_ALLOWED'),
      recipient(FIXTURE_SECONDARY_ROLE, 'contact-secondary', 'PRIVACY_INDETERMINATE'),
    );

    expect(feedSummary(feed)).toMatchObject({
      attentions: ['FAILURE', 'FAILURE'],
      partial: false,
      reasons: ['PRIVACY_NOT_ALLOWED', 'PRIVACY_INDETERMINATE'],
      requiredOutcome: 'FAILED',
    });
  });

  it('BR-07: a required type whose approved rule went stale reports why and leaves the source decision to its owner', () => {
    const stale = fixtureRegistry(requiredTwoSlotTypeWith({ status: 'STALE' }));
    const feed = feedOfDecision(decideOrThrow(stale, requiredRequest, fixtureContext([original, secondary])));

    expect(feed).toMatchObject({
      noMessageReason: 'TYPE_STALE',
      requiredOutcome: 'FAILED',
      sourceImpact: 'SOURCE_OWNER_DECIDES',
    });
  });

  it('Scenario: a required slot with an ambiguous recipient fails truthfully and never picks one', () => {
    const feed = feedFor(original, recipient(FIXTURE_ORIGINAL_ROLE, 'contact-other'), secondary);

    expect(feedSummary(feed)).toMatchObject({ partial: true, requiredOutcome: 'FAILED' });
    expect(feed.unresolvedSlots).toEqual([{ reason: 'RECIPIENT_AMBIGUOUS', slotKey: 'primary' }]);
    expect(feed.messages.map(({ slotKey }) => slotKey)).toEqual(['secondary']);
  });

  it('BR-08: a stale source is a stop, not a required-communication failure caused by Communications', () => {
    const decision = decideOrThrow(
      registry,
      requiredRequest,
      fixtureContext([original, secondary], { state: FIXTURE_CLOSED_STATE }),
    );

    expect(feedOfDecision(decision)).toMatchObject({
      noMessageReason: 'SOURCE_STATE_INELIGIBLE',
      requiredOutcome: 'SOURCE_STALE',
      sourceImpact: 'SOURCE_OWNER_DECIDES',
    });
  });

  it('BR-06: an optional type owes the source nothing', () => {
    const blocked = recipient(FIXTURE_ORIGINAL_ROLE, 'contact-original', 'PRIVACY_NOT_ALLOWED');
    const optional = decideOrThrow(registry, fixtureRequest(), fixtureContext([blocked]));

    expect(feedOfDecision(optional).requiredOutcome).toBe('NOT_REQUIRED');
  });

  it('an unknown purpose is never a prepared required communication: its requiredness is unknown', () => {
    const unknown = decideOrThrow(registry, fixtureRequest({ purpose: 'fixture.unknown' }), fixtureContext([]));

    expect(feedOfDecision(unknown)).toMatchObject({
      noMessageReason: 'UNKNOWN_PURPOSE',
      requiredOutcome: 'REQUIREDNESS_UNKNOWN',
    });
  });

  it('a type owned by another source is not described to the issuer and is reported as unknown too', () => {
    const foreign = decideOrThrow(
      registry,
      fixtureRequest({ moduleKey: 'fixture.other-source', purpose: 'fixture.paired' }),
      fixtureContext([original, secondary]),
    );

    expect(feedOfDecision(foreign)).toMatchObject({
      noMessageReason: 'SOURCE_NOT_AUTHORIZED_FOR_TYPE',
      requiredOutcome: 'REQUIREDNESS_UNKNOWN',
    });
  });
});
