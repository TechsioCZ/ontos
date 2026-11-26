import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { NodeCrypto } from '@effect/platform-node';
import { describe, expect, it, rs } from 'effect-rstest';

import { PortalAuthIssuanceRefSchema } from '../../shared/portal-auth-communications.ts';
import {
  CommercePortalAuthProtectedValueSealer,
  protectedValueSealerLayer,
} from '../../src/portal-auth/communications/protected-value.ts';
import type { HeldIssuance } from '../../src/portal-auth/communications/issuance.ts';

/** #1406 D2 (review A6): the sealer's key derivation. Every value is FICTIONAL. */

const issuedAt = DateTime.makeUnsafe('2026-11-22T10:00:00.000Z');
const held: HeldIssuance = {
  endpoint: Redacted.make('fictional@example.test'),
  issuance: {
    expiresAt: DateTime.add(issuedAt, { minutes: 30 }),
    flow: 'reset-password',
    issuanceRef: Schema.decodeSync(PortalAuthIssuanceRefSchema)('pa-protected-value-1'),
    issuedAt,
    providerSubjectId: 'FICTIONAL-subject',
  },
  secret: Redacted.make('https://fictional.example.test/reset'),
};

describe('The protected value sealer (#1406 D2)', () => {
  it.effect(
    'A6: a failed key derivation is not kept: the next seal derives the key again and opens what it sealed',
    () =>
      Effect.gen(function* transientDerivationFailure() {
        const { subtle } = globalThis.crypto;
        const importKey = rs
          .spyOn(subtle, 'importKey')
          .mockImplementationOnce(() => Promise.reject(new Error('fictional transient WebCrypto failure')));
        yield* Effect.addFinalizer(() => Effect.sync(() => importKey.mockRestore()));
        const sealer = yield* CommercePortalAuthProtectedValueSealer.pipe(
          Effect.provide(protectedValueSealerLayer(Redacted.make('fictional-realm-secret-of-at-least-32-chars'))),
        );
        const first = yield* Effect.flip(sealer.seal(held));
        expect(first).toMatchObject({ operation: 'protected-value-seal' });
        const sealed = yield* sealer.seal(held);
        const opened = yield* sealer.open(held.issuance, sealed);
        expect(opened.pipe(Option.map(({ secret }) => Redacted.value(secret)))).toStrictEqual(
          Option.some('https://fictional.example.test/reset'),
        );
        expect(importKey).toHaveBeenCalledTimes(2);
      }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );
});
