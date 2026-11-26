import { Context, Effect, Layer, Redacted } from 'effect';

import { portalAuthOwnerRenderedSlotOf } from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthEmailFlow, PortalAuthIssuanceRef } from '../../../shared/portal-auth-communications.ts';
import type { PortalAuthIssuanceStateUnavailable } from './issuance-state-unavailable.ts';
import { OwnerSlotStop } from './owner-slot-stop.ts';
import { CommercePortalAuthProtectedHandoff } from './protected-handoff.ts';

/**
 * The protected rendering seam (ADR-0022). After Communications has picked the approved type, the actual language and the
 * pinned Template Revision, the Messaging Adapter renders the revision GENERICALLY (the generic renderer leaves every
 * `owner-rendered` placeholder untouched and refuses any value for it) and then asks Auth, under Auth's own authority, to
 * complete exactly those slots. Auth answers each slot with a `Redacted` value only while its own Current lifecycle says the
 * issuance is usable; otherwise it answers a typed stop and reproduces nothing.
 *
 * The seam is physically one-way: the pin, the intent, the history and the request carry no secret field, the Communication
 * Request has no value field, and this service is the only code that returns the protected value.
 */
export interface OwnerSlotCompletionService {
  readonly complete: (input: {
    readonly flow: PortalAuthEmailFlow;
    readonly issuanceRef: PortalAuthIssuanceRef;
    readonly slots: readonly string[];
  }) => Effect.Effect<ReadonlyMap<string, Redacted.Redacted>, OwnerSlotStop | PortalAuthIssuanceStateUnavailable>;
}

export class CommercePortalAuthOwnerSlotCompletion extends Context.Service<
  CommercePortalAuthOwnerSlotCompletion,
  OwnerSlotCompletionService
>()(
  '@app/commerce-customer-context/portal-auth/communications/owner-completion/CommercePortalAuthOwnerSlotCompletion',
) {}

export const ownerSlotCompletionLayer = Layer.effect(
  CommercePortalAuthOwnerSlotCompletion,
  Effect.gen(function* makeOwnerSlotCompletion() {
    const handoff = yield* CommercePortalAuthProtectedHandoff;
    return {
      complete: Effect.fn('CommercePortalAuthOwnerSlotCompletion.complete')(function* completeSlots({
        flow,
        issuanceRef,
        slots,
      }) {
        // the flow owns exactly one secret slot; a template that asks for another one is refused before anything is read
        if (slots.some((slot) => slot !== portalAuthOwnerRenderedSlotOf(flow))) {
          return yield* new OwnerSlotStop({ reason: 'SLOT_NOT_DECLARED' });
        }
        const entries = yield* Effect.forEach(
          slots,
          (slot) =>
            handoff.revealSecret({ flow, issuanceRef, slot }).pipe(Effect.map((value) => [slot, value] as const)),
          { concurrency: 1 },
        );
        return new Map(entries);
      }),
    } satisfies OwnerSlotCompletionService;
  }),
);

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const keepAsIs = (value: string) => value;
const slotPattern = /\{\{\s*(?<name>[a-z][a-z0-9_]*)\s*\}\}/gu;

/** The message exactly as the generic renderer left it: owner slots still in place. */
interface GenericRendering {
  readonly html: string;
  readonly subject: string;
  readonly text: string;
}

const fillSlots = (text: string, values: ReadonlyMap<string, Redacted.Redacted>, present: (value: string) => string) =>
  text.replaceAll(slotPattern, (token, name: string) => {
    const value = values.get(name);
    return value === undefined ? token : present(Redacted.value(value));
  });

/**
 * Fills the owner-rendered slots of a generically rendered message. The result is for the transport edge only and is
 * `Redacted`: it is never stored, logged or returned to a caller outside the Messaging Adapter. A slot without a value
 * stays in place, so a message is never sent with half a link. A subject is one line and never carries a secret slot.
 */
export const fillOwnerRenderedSlots = (
  rendering: GenericRendering,
  values: ReadonlyMap<string, Redacted.Redacted>,
) => ({
  html: Redacted.make(fillSlots(rendering.html, values, escapeHtml)),
  subject: rendering.subject,
  text: Redacted.make(fillSlots(rendering.text, values, keepAsIs)),
});
