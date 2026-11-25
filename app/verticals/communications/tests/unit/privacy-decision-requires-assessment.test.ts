import { DateTime } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PrivacyAssessment } from '../../src/domain/privacy/assess-privacy.ts';
import {
  decideMessage,
  decideUnaskedMessage,
  HandoffFact,
  MessageHandoffDecision,
  ProviderFact,
  SourceCurrentness,
} from '../../src/domain/privacy/suppression.ts';
import { HandoffVerdict } from '../../src/domain/recipient/recheck-before-handoff.ts';
import { FIXTURE_ORIGINAL_ROLE, fixtureType } from './support/catalog-fixtures.ts';
import { processingScope } from './support/privacy-fixtures.ts';
import { binding, evaluationInput, intentIdentity } from './support/recipient-fixtures.ts';

/**
 * [#1396 BR-01 AC-02, T4-04] Privacy MUST have been asked before a message that can still be handed off is decided: the input type
 * of `decideMessage` has no way to state "not asked", so a `Proceed` without a Privacy question cannot compile. A message that
 * is not asked about (its handoff is proven, or its effect unknown) is decided by `decideUnaskedMessage` and carries no Privacy
 * answer by design.
 */
const recipient = binding(FIXTURE_ORIGINAL_ROLE, 'recipient-a');
const identity = intentIdentity(evaluationInput(fixtureType(), [recipient]), recipient, 'primary');
const evaluatedAt = DateTime.makeUnsafe(Date.UTC(2026, 10, 25, 12));
const common = {
  evaluatedAt,
  identity,
  provider: ProviderFact.Clear(),
  recipient: HandoffVerdict.AlreadyHandedOff({ identity, reconciliationRequired: false }),
  scope: processingScope('recipient-a'),
  source: SourceCurrentness.Current(),
};

const withoutPrivacy = () =>
  // @ts-expect-error `privacy` is required: a message that may still be handed off cannot be decided without it
  decideMessage({ ...common, handoff: HandoffFact.NotAttempted() });

describe('a decision needs the Privacy answer of a message that may still be handed off', () => {
  it('rejects, at compile time, a stoppable message that carries no Privacy assessment', () => {
    expect(withoutPrivacy).toBeTypeOf('function');
  });

  it('accepts the Privacy answer for such a message and records it as the evidence of the decision', () => {
    const privacy = PrivacyAssessment.Unavailable({
      assessedAt: evaluatedAt,
      reason: 'OWNER_UNAVAILABLE',
      scopeKey: 'k',
    });
    const decision = decideMessage({ ...common, handoff: HandoffFact.NotAttempted(), privacy });

    expect(MessageHandoffDecision.$is('Suppressed')(decision)).toBe(true);
    expect(decision).toMatchObject({
      evidence: { privacy },
      primary: { category: 'PRIVACY_AUTHORITY_UNAVAILABLE', proven: false },
    });
  });

  it('needs no Privacy answer for a message that is not asked about: proven handed off, or an unknown effect', () => {
    expect(
      MessageHandoffDecision.$is('AlreadyHandedOff')(
        decideUnaskedMessage({ ...common, handoff: HandoffFact.ProvenHandedOff() }),
      ),
    ).toBe(true);
    expect(
      MessageHandoffDecision.$is('ReconciliationRequired')(
        decideUnaskedMessage({ ...common, handoff: HandoffFact.EffectUnknown() }),
      ),
    ).toBe(true);
  });
});
