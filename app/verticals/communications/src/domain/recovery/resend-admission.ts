import { Context, Option } from 'effect';
import type { Effect } from 'effect';

import type { CommunicationDecisionUnavailable } from '../../../shared/communication-intake-errors.ts';
import { resendPolicyOf } from '../catalog/message-type.ts';
import type { TransactionalMessageType } from '../catalog/message-type.ts';
import type { ResendRefusal } from '../catalog/vocabulary.ts';
import type { EffectBlock } from '../history/unknown-effect.ts';

/**
 * Admission of an Explicit Resend (#1403, PO 1A): a NEW source request that names an ORIGINAL Message Intent. It is a pure
 * decision over the approved type and what the owner's own store says about the original. It grants nothing a request does not
 * already have: the ordinary decision still asks the catalog, the recipient owner, Privacy and the language pin for the NEW
 * message, and a resend changes no business state and rewrites no earlier outcome (R-09).
 *
 * What the owner's store says about the original, without a recipient, an address or a payload.
 */
export interface ResendOriginalFacts {
  /** What the history alone says about the original's external effect; absent when it is known (accepted or provably absent). */
  readonly effectBlock: Option.Option<EffectBlock>;
  /**
   * The original is still waiting for ANY outcome: it is pending its handoff and nothing about it is final yet (no attempt that
   * may have left has a known answer, no proven stop). It can still be delivered by the ordinary step, so a resend now could
   * create two messages for one occurrence.
   */
  readonly pendingWithoutOutcome: boolean;
  /** The scope key of the ORIGINAL's request (`scopeKey` of its Legal Entity, profile, counterparty and storefront). */
  readonly scopeKey: string;
  readonly sourceModule: string;
  readonly typeId: string;
}

/**
 * Why a resend is refused, or none when it is admitted. In this order:
 * 1. the type must have the source owner's resend approval; nothing else is read or revealed when it has not (a tenant
 *    switch, an operator permission or access to the history never grants it);
 * 2. the original must exist in this Tenant, belong to the SAME source owner and have been requested in the SAME scope (Legal
 *    Entity, profile, counterparty, storefront) as the resend: another source's intent, another scope's intent and an unknown
 *    one are answered alike, so a source learns nothing about intents that are not its own, and a resend can never reach a
 *    message of another Legal Entity;
 * 3. the original must be a message of the SAME type: this is a resend of THAT message, not a path to another one;
 * 4. the original's external effect must not be unknown or contradicted, and the original must not still be waiting for any
 *    outcome: a new copy is never created while it is not known whether the first one left (R-05), nor while the first one may
 *    still be delivered by the ordinary step (the source can issue a new occurrence later). An acceptance, and a provable
 *    failure, are no obstacle: they are the reasons resending exists.
 */
export const resendRefusalOf = (
  type: Pick<TransactionalMessageType, 'resend' | 'typeId'>,
  sourceModule: string,
  requestScopeKey: string,
  original: Option.Option<ResendOriginalFacts>,
): Option.Option<ResendRefusal> => {
  if (resendPolicyOf(type) !== 'SOURCE_APPROVED') {
    return Option.some('RESEND_NOT_APPROVED');
  }
  if (
    Option.isNone(original) ||
    original.value.sourceModule !== sourceModule ||
    original.value.scopeKey !== requestScopeKey
  ) {
    return Option.some('RESEND_ORIGINAL_NOT_FOUND');
  }
  if (original.value.typeId !== type.typeId) {
    return Option.some('RESEND_ORIGINAL_TYPE_MISMATCH');
  }
  const unknownEffect =
    Option.isSome(original.value.effectBlock) && original.value.effectBlock.value !== 'ACCEPTANCE_ALREADY_PROVEN';
  return unknownEffect || original.value.pendingWithoutOutcome
    ? Option.some('RESEND_ORIGINAL_EFFECT_UNKNOWN')
    : Option.none();
};

/**
 * The owner-local read of the original intent of a resend, bound to the Action's own transaction and Tenant. It answers only
 * what the admission needs (source owner, type, what the history says about the external effect) and never an address or a
 * payload. None is a proven absence, not an unreadable store.
 */
export interface ResendOriginalPortContract {
  readonly findOriginal: (
    originalIntentId: string,
  ) => Effect.Effect<Option.Option<ResendOriginalFacts>, InstanceType<typeof CommunicationDecisionUnavailable>>;
}

/** The Context tag of the port: the Action's service composes it over its own scoped transaction, tests over an in-memory store. */
export class ResendOriginalPort extends Context.Service<ResendOriginalPort, ResendOriginalPortContract>()(
  '@app/communications/domain/recovery/resend-admission/ResendOriginalPort',
) {}
