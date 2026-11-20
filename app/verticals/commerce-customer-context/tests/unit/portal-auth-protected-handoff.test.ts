import { DateTime, Effect, Option, Redacted, Schema, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { PortalAuthIssuanceRefSchema } from '../../shared/portal-auth-communications.ts';
import type { PortalAuthEmailFlow } from '../../shared/portal-auth-communications.ts';
import { PortalAuthIssuanceStateUnavailable } from '../../src/portal-auth/communications/issuance-state-unavailable.ts';
import { OwnerSlotStop } from '../../src/portal-auth/communications/owner-slot-stop.ts';
import type { HeldIssuance } from '../../src/portal-auth/communications/issuance.ts';
import {
  issuanceSourceStateOf,
  maskedAddressOf,
  originalEndpointOf,
} from '../../src/portal-auth/communications/owner-facts.ts';
import {
  CommercePortalAuthOwnerSlotCompletion,
  fillOwnerRenderedSlots,
  ownerSlotCompletionLayer,
} from '../../src/portal-auth/communications/owner-completion.ts';
import type { IssuanceLedgerProbe } from '../../src/portal-auth/communications/protected-handoff.ts';
import {
  CommercePortalAuthProtectedHandoff,
  protectedHandoffLayer,
} from '../../src/portal-auth/communications/protected-handoff.ts';

/**
 * #1406 ADR-0022 and AC-06: the protected handoff holds an issuance only in this process, answers only Auth's own Current
 * lifecycle, completes only the slot the flow owns, and never reproduces or reissues anything. Every value below is FICTIONAL.
 */

const ref = Schema.decodeSync(PortalAuthIssuanceRefSchema);
const SECRET = 'https://portal.example.test/api/portal-auth/verify-email?token=fictional-token';
const ADDRESS = 'holder@example.test';
const ISSUED_AT = DateTime.makeUnsafe('2026-11-19T10:00:00.000Z');

const held = (
  flow: PortalAuthEmailFlow,
  name: string,
  overrides: { readonly lifetimeMinutes?: number; readonly subject?: string } = {},
): HeldIssuance => ({
  endpoint: Redacted.make(ADDRESS),
  issuance: {
    expiresAt: DateTime.add(ISSUED_AT, { minutes: overrides.lifetimeMinutes ?? 15 }),
    flow,
    issuanceRef: ref(name),
    issuedAt: ISSUED_AT,
    providerSubjectId: overrides.subject ?? 'subject-1',
  },
  ledgerToken: Redacted.make('fictional-ledger-token'),
  secret: Redacted.make(SECRET),
});

const current: IssuanceLedgerProbe = () => Effect.succeed('CURRENT');
const withHandoff = (probe: IssuanceLedgerProbe = current) =>
  Effect.gen(function* handoff() {
    return yield* CommercePortalAuthProtectedHandoff;
  }).pipe(Effect.provide(protectedHandoffLayer(probe)));

describe('The protected Auth handoff (#1406, ADR-0022)', () => {
  it.effect(
    "answers CURRENT only for a held, unexpired issuance that Auth's ledger still offers, and reveals only its own slot",
    () =>
      Effect.gen(function* currentIssuance() {
        const handoff = yield* withHandoff();
        yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
        yield* handoff.hold(held('verify-email', 'pa-1'), { supersede: true });
        expect(yield* handoff.currentness(ref('pa-1'))).toBe('CURRENT');
        const value = yield* handoff.revealSecret({
          flow: 'verify-email',
          issuanceRef: ref('pa-1'),
          slot: 'verification_link',
        });
        expect(Redacted.value(value)).toBe(SECRET);
        // the value prints as redacted wherever it is logged or serialized
        expect(JSON.stringify(value)).toBe('"<redacted>"');
        expect(JSON.stringify(held('verify-email', 'pa-1'))).not.toContain(SECRET);
        expect(JSON.stringify(held('verify-email', 'pa-1'))).not.toContain(ADDRESS);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "refuses another flow's slot, a slot no flow declared and the issuance of another flow, revealing nothing",
    () =>
      Effect.gen(function* wrongSlot() {
        const handoff = yield* withHandoff();
        yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
        yield* handoff.hold(held('otp', 'pa-otp'), { supersede: true });
        for (const slot of ['verification_link', 'reset_link', 'anything_else']) {
          const stop = yield* Effect.flip(handoff.revealSecret({ flow: 'otp', issuanceRef: ref('pa-otp'), slot }));
          expect(Schema.is(OwnerSlotStop)(stop)).toBe(true);
          expect(stop).toMatchObject({ reason: 'SLOT_NOT_DECLARED' });
        }
        const otherFlow = yield* Effect.flip(
          handoff.revealSecret({ flow: 'reset-password', issuanceRef: ref('pa-otp'), slot: 'reset_link' }),
        );
        expect(Schema.is(OwnerSlotStop)(otherFlow)).toBe(true);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    'stops, truthfully, on expiry, on a spent or revoked issuance and after a restart, and never reproduces the secret',
    () =>
      Effect.gen(function* stops() {
        const handoff = yield* withHandoff();
        yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
        yield* handoff.hold(held('reset-password', 'pa-r1'), { supersede: false });
        yield* handoff.hold(held('reset-password', 'pa-r2'), { supersede: false });
        // every unexpired reset link stays valid: a new one does not revoke the older one
        expect(yield* handoff.currentness(ref('pa-r1'))).toBe('CURRENT');
        yield* handoff.settle({ issuanceRef: ref('pa-r1'), state: 'CONSUMED' });
        yield* handoff.settle({ issuanceRef: ref('pa-r2'), state: 'REVOKED' });
        expect(yield* handoff.currentness(ref('pa-r1'))).toBe('CONSUMED');
        expect(yield* handoff.currentness(ref('pa-r2'))).toBe('REVOKED');
        // a settled issuance never becomes usable again
        yield* handoff.settle({ issuanceRef: ref('pa-r1'), state: 'REVOKED' });
        expect(yield* handoff.currentness(ref('pa-r1'))).toBe('CONSUMED');
        for (const issuanceRef of [ref('pa-r1'), ref('pa-r2')]) {
          const stop = yield* Effect.flip(
            handoff.revealSecret({ flow: 'reset-password', issuanceRef, slot: 'reset_link' }),
          );
          expect(Schema.is(OwnerSlotStop)(stop)).toBe(true);
        }

        yield* handoff.hold(held('reset-password', 'pa-r3'), { supersede: false });
        yield* TestClock.adjust('16 minutes');
        expect(yield* handoff.currentness(ref('pa-r3'))).toBe('EXPIRED');

        // a restart: a fresh process-local state holds nothing, and says so
        const restarted = yield* withHandoff();
        expect(yield* restarted.currentness(ref('pa-r3'))).toBe('NOT_RESUMABLE');
        expect(
          yield* Effect.flip(
            restarted.revealSecret({ flow: 'reset-password', issuanceRef: ref('pa-r3'), slot: 'reset_link' }),
          ),
        ).toMatchObject({
          reason: 'NOT_RESUMABLE',
        });
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect('a new verification link or code revokes the earlier one of the same subject and flow, and no other', () =>
    Effect.gen(function* supersede() {
      const handoff = yield* withHandoff();
      yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
      yield* handoff.hold(held('otp', 'pa-a'), { supersede: true });
      yield* handoff.hold(held('otp', 'pa-b', { subject: 'subject-2' }), { supersede: true });
      yield* handoff.hold(held('otp', 'pa-c'), { supersede: true });
      expect(yield* handoff.currentness(ref('pa-a'))).toBe('REVOKED');
      expect(yield* handoff.currentness(ref('pa-b'))).toBe('CURRENT');
      expect(yield* handoff.currentness(ref('pa-c'))).toBe('CURRENT');
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "reads Auth's own ledger: an issuance the ledger no longer offers is NO_LONGER_CURRENT, an unreadable ledger is uncertainty",
    () =>
      Effect.gen(function* ledger() {
        const offered = { unreadable: false, value: true };
        const handoff = yield* withHandoff((entry) =>
          offered.unreadable
            ? Effect.fail(new PortalAuthIssuanceStateUnavailable({ flow: entry.issuance.flow }))
            : Effect.succeed(offered.value ? 'CURRENT' : 'NO_LONGER_CURRENT'),
        );
        yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
        yield* handoff.hold(held('verify-email', 'pa-l'), { supersede: true });
        expect(yield* handoff.currentness(ref('pa-l'))).toBe('CURRENT');
        offered.value = false;
        expect(yield* handoff.currentness(ref('pa-l'))).toBe('NO_LONGER_CURRENT');
        offered.unreadable = true;
        expect(
          Schema.is(PortalAuthIssuanceStateUnavailable)(yield* Effect.flip(handoff.currentness(ref('pa-l')))),
        ).toBe(true);
        expect(issuanceSourceStateOf('NO_LONGER_CURRENT')).toBe(
          'commerce.customer-context.portal-auth.issuance-revoked',
        );
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect('owner reservations are single use and keyed by flow and subject', () =>
    Effect.gen(function* reservations() {
      const handoff = yield* withHandoff();
      yield* handoff.reserve({
        flow: 'verify-email',
        providerSubjectId: 'subject-1',
        reservation: { enrollmentOwnerInvocationId: 'enrollment-1', issuanceRef: ref('pae-1') },
      });
      expect(Option.isNone(yield* handoff.takeReservation('otp', 'subject-1'))).toBe(true);
      expect(Option.isNone(yield* handoff.takeReservation('verify-email', 'subject-2'))).toBe(true);
      expect(Option.getOrThrow(yield* handoff.takeReservation('verify-email', 'subject-1')).issuanceRef).toBe('pae-1');
      expect(Option.isNone(yield* handoff.takeReservation('verify-email', 'subject-1'))).toBe(true);
    }),
  );
});

describe("Auth's owner facts and slot completion (#1406)", () => {
  it.effect('the ORIGINAL address answers only for the account the issuance was made for, only while Current', () =>
    Effect.gen(function* originalAddress() {
      const handoff = yield* withHandoff();
      yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
      yield* handoff.hold(held('reset-password', 'pa-e1'), { supersede: false });
      const own = yield* originalEndpointOf(handoff, { issuanceRef: ref('pa-e1'), recipientSubjectId: 'subject-1' });
      expect(Redacted.value(Option.getOrThrow(own))).toBe(ADDRESS);
      // the same address under another subject never merges: nothing answers for it
      expect(
        Option.isNone(
          yield* originalEndpointOf(handoff, { issuanceRef: ref('pa-e1'), recipientSubjectId: 'subject-2' }),
        ),
      ).toBe(true);
      expect(
        Option.isNone(
          yield* originalEndpointOf(handoff, { issuanceRef: ref('unknown'), recipientSubjectId: 'subject-1' }),
        ),
      ).toBe(true);
      yield* handoff.settle({ issuanceRef: ref('pa-e1'), state: 'REVOKED' });
      expect(
        Option.isNone(
          yield* originalEndpointOf(handoff, { issuanceRef: ref('pa-e1'), recipientSubjectId: 'subject-1' }),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it('the stored mask hides the address: it is never the whole address and keeps only the domain', () => {
    const mask = maskedAddressOf(Redacted.make(ADDRESS));
    expect(mask).toBe('h***@example.test');
    expect(mask).not.toBe(ADDRESS);
  });

  it.effect(
    'the owner-slot completion fills the slot with a protected value and stops, typed, when the issuance cannot be completed',
    () =>
      Effect.gen(function* completion() {
        const handoffLayer = protectedHandoffLayer(current);
        const layers = Layer.merge(handoffLayer, ownerSlotCompletionLayer.pipe(Layer.provide(handoffLayer)));
        const { complete, handoff } = yield* Effect.gen(function* services() {
          return {
            complete: yield* CommercePortalAuthOwnerSlotCompletion,
            handoff: yield* CommercePortalAuthProtectedHandoff,
          };
        }).pipe(Effect.provide(layers));
        yield* TestClock.setTime(ISSUED_AT.epochMilliseconds);
        yield* handoff.hold(held('verify-email', 'pa-c1'), { supersede: true });
        const values = yield* complete.complete({
          flow: 'verify-email',
          issuanceRef: ref('pa-c1'),
          slots: ['verification_link'],
        });
        const filled = fillOwnerRenderedSlots(
          { html: '<p>Open: {{verification_link}}</p>', subject: 'Subject', text: 'Open: {{ verification_link }}' },
          values,
        );
        expect(Redacted.value(filled.text)).toBe(`Open: ${SECRET}`);
        expect(Redacted.value(filled.html)).toContain('token=fictional-token');
        expect(JSON.stringify(filled.text)).toBe('"<redacted>"');
        // a slot the flow does not own is refused before anything is read
        expect(
          yield* Effect.flip(
            complete.complete({ flow: 'verify-email', issuanceRef: ref('pa-c1'), slots: ['otp_code'] }),
          ),
        ).toMatchObject({ reason: 'SLOT_NOT_DECLARED' });
        // a slot without a value stays in place: a message is never completed with half a link
        expect(
          Redacted.value(fillOwnerRenderedSlots({ html: '{{x}}', subject: 's', text: '{{x}}' }, new Map()).text),
        ).toBe('{{x}}');
      }).pipe(Effect.provide(TestClock.layer())),
  );
});
