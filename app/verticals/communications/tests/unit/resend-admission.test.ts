import { Option } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommunicationOutcome } from '../../src/domain/catalog/decision.ts';
import type { ResendRefusal } from '../../src/domain/catalog/vocabulary.ts';
import { communicationRequest, originalRecipient } from '../support/intake-fixtures.ts';
import { scopeKey } from '../../src/domain/recipient/original-binding.ts';
import { resendRefusalOf } from '../../src/domain/recovery/resend-admission.ts';
import type { ResendOriginalFacts } from '../../src/domain/recovery/resend-admission.ts';
import {
  FIXTURE_ORIGINAL_ROLE,
  FIXTURE_SOURCE_MODULE,
  decideOrThrow,
  fixtureContext,
  fixtureRegistry,
  fixtureRequest,
  fixtureType,
  recipient,
} from './support/catalog-fixtures.ts';

/**
 * [#1403 R-02 R-03 R-05 R-11 AC-04 AC-10] Explicit Resend is admitted only for a type whose source owner approved it, only for
 * an original of the SAME source owner and type, and never while it is unknown whether the original left. The result of a refusal
 * is an ordinary NO_MESSAGE decision with a closed reason, so the source learns it through the ordinary outcome feed.
 */
const approvedType = fixtureType({ resend: 'SOURCE_APPROVED' });
const scopeOf = (legalEntityId?: string) =>
  scopeKey(
    communicationRequest({
      bindings: [originalRecipient('customer-1')],
      legalEntityId,
    }).scope,
  );
const REQUEST_SCOPE = scopeOf();
const original = (overrides: Partial<ResendOriginalFacts> = {}): Option.Option<ResendOriginalFacts> =>
  Option.some({
    effectBlock: Option.none(),
    pendingWithoutOutcome: false,
    scopeKey: REQUEST_SCOPE,
    sourceModule: FIXTURE_SOURCE_MODULE,
    typeId: approvedType.typeId,
    ...overrides,
  });
const refusal = (
  type: typeof approvedType,
  found: Option.Option<ResendOriginalFacts>,
  source = FIXTURE_SOURCE_MODULE,
  scope = REQUEST_SCOPE,
) => Option.getOrUndefined(resendRefusalOf(type, source, scope, found));

describe('resendRefusalOf', () => {
  it('[S10 S11 AC-04] admits a resend of an approved type, of the same source owner and type, whose effect is known', () => {
    expect(refusal(approvedType, original())).toBeUndefined();
    // the original may have been accepted: that is exactly why a deliberate resend exists
    expect(refusal(approvedType, original({ effectBlock: Option.some('ACCEPTANCE_ALREADY_PROVEN') }))).toBeUndefined();
  });

  it("[S11 AC-10] a type without the source owner's approval has no resend, whoever asks and whatever the original is", () => {
    expect(refusal(fixtureType(), original())).toBe('RESEND_NOT_APPROVED');
    expect(refusal(fixtureType({ resend: 'NOT_ALLOWED' }), original())).toBe('RESEND_NOT_APPROVED');
    // nothing about the original is consulted: a missing one gives the same answer
    expect(refusal(fixtureType(), Option.none())).toBe('RESEND_NOT_APPROVED');
  });

  it('answers an unknown original and the original of ANOTHER source owner alike: a source learns nothing about intents that are not its own', () => {
    expect(refusal(approvedType, Option.none())).toBe('RESEND_ORIGINAL_NOT_FOUND');
    expect(refusal(approvedType, original({ sourceModule: 'fixture.other-source' }))).toBe('RESEND_ORIGINAL_NOT_FOUND');
  });

  it('[review] an original requested in ANOTHER scope (another Legal Entity, profile, counterparty or storefront) is answered exactly like an unknown one', () => {
    const otherEntity = scopeOf('55555555-5555-4555-8555-555555555555');
    expect(refusal(approvedType, original({ scopeKey: otherEntity }))).toBe('RESEND_ORIGINAL_NOT_FOUND');
    // no oracle: a same-scope original of another TYPE is the only one that learns the type differs
    expect(refusal(approvedType, original({ scopeKey: otherEntity, typeId: 'fixture.other-message' }))).toBe(
      'RESEND_ORIGINAL_NOT_FOUND',
    );
    expect(refusal(approvedType, original(), FIXTURE_SOURCE_MODULE, otherEntity)).toBe('RESEND_ORIGINAL_NOT_FOUND');
  });

  it('[review] an original that is still waiting for any outcome is refused like an unknown effect: both could be delivered', () => {
    expect(refusal(approvedType, original({ pendingWithoutOutcome: true }))).toBe('RESEND_ORIGINAL_EFFECT_UNKNOWN');
  });

  it('a resend is a resend of THAT type, never a path to another message', () => {
    expect(refusal(approvedType, original({ typeId: 'fixture.other-message' }))).toBe('RESEND_ORIGINAL_TYPE_MISMATCH');
  });

  it('[R-05] never creates a second copy while it is unknown whether the first one left, or the evidence contradicts itself', () => {
    expect(refusal(approvedType, original({ effectBlock: Option.some('RECONCILIATION_REQUIRED') }))).toBe(
      'RESEND_ORIGINAL_EFFECT_UNKNOWN',
    );
    expect(refusal(approvedType, original({ effectBlock: Option.some('CONTRADICTORY_EVIDENCE') }))).toBe(
      'RESEND_ORIGINAL_EFFECT_UNKNOWN',
    );
  });
});

describe('the decision of a refused resend', () => {
  const request = fixtureRequest();
  const candidates = fixtureContext([recipient(FIXTURE_ORIGINAL_ROLE, 'customer-1')]);

  it.each<ResendRefusal>([
    'RESEND_NOT_APPROVED',
    'RESEND_ORIGINAL_NOT_FOUND',
    'RESEND_ORIGINAL_TYPE_MISMATCH',
    'RESEND_ORIGINAL_EFFECT_UNKNOWN',
  ])('[AC-04] %s is NO_MESSAGE with that reason, creates no candidate and names the approved type', (resendRefusal) => {
    const decision = decideOrThrow(fixtureRegistry(approvedType), request, { ...candidates, resendRefusal });
    expect(CommunicationOutcome.$is('NoMessage')(decision.outcome) && decision.outcome.reason).toBe(resendRefusal);
    expect(Option.isSome(decision.type)).toBe(true);
  });

  it('an admitted resend is decided exactly like any request: no refusal in the context means no shortcut and no extra step', () => {
    const ordinary = decideOrThrow(fixtureRegistry(approvedType), request, candidates);
    expect(CommunicationOutcome.$is('Candidates')(ordinary.outcome)).toBe(true);
    expect(Option.isSome(ordinary.type)).toBe(true);
  });

  it('a refusal never overrides the stop of a deactivated type or a stale source: the earlier reason is kept', () => {
    const deactivated = fixtureType({ resend: 'SOURCE_APPROVED', status: 'DEACTIVATED' });
    const decision = decideOrThrow(fixtureRegistry(deactivated), request, {
      ...candidates,
      resendRefusal: 'RESEND_NOT_APPROVED',
    });
    expect(CommunicationOutcome.$is('NoMessage')(decision.outcome) && decision.outcome.reason).toBe('TYPE_DEACTIVATED');
  });
});
