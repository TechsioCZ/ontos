import { Effect, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { claimHostedModuleCredentials } from '../../src/auth/hosted-module-credential-store.ts';
import { HostedModuleCredentialsSealedError } from '../../src/auth/hosted-module-credentials.ts';
import { ownModuleCredential } from '../../src/auth/owner-module-credential.ts';

const ORDER_KEY = 'order-module-credential-0001';
const PARTY_KEY = 'party-module-credential-0001';

/** A fresh read each time, as every delegated call reads its credential. */
const readAs = (appId: string) =>
  ownModuleCredential(appId).pipe(Effect.map((key) => (Option.isSome(key) ? Redacted.value(key.value) : undefined)));

it.effect('claims a copy once; only its receiver fills an owner slot, and replaces it later', () =>
  Effect.gen(function* claimOnce() {
    // Unclaimed: the copy holds no key at all.
    expect(yield* readAs('commerce-order')).toBeUndefined();

    const receiver = yield* claimHostedModuleCredentials(['commerce-order', 'party-registry']);
    // Claimed and empty: still no key.
    expect(yield* readAs('commerce-order')).toBeUndefined();
    const refusedClaim = yield* Effect.flip(claimHostedModuleCredentials(['commerce-order']));
    expect(Schema.is(HostedModuleCredentialsSealedError)(refusedClaim)).toBe(true);

    // The boot handover fills one owner; an owner this copy does not serve is refused.
    expect(
      yield* receiver.accept({
        credentials: { 'commerce-order': Redacted.make(ORDER_KEY), pricing: Redacted.make('pricing-module-key-0000') },
        schemaVersion: 1,
      }),
    ).toEqual({ accepted: ['commerce-order'], refused: ['pricing'] });
    expect(yield* readAs('commerce-order')).toBe(ORDER_KEY);
    expect(yield* readAs('party-registry')).toBeUndefined();
    // A later handover fills the owner that still holds none and replaces a held key (a renewal or a rotation).
    expect(
      yield* receiver.accept({
        credentials: {
          'commerce-order': Redacted.make('replacement-order-module-key'),
          'party-registry': Redacted.make(PARTY_KEY),
        },
        schemaVersion: 1,
      }),
    ).toEqual({ accepted: ['commerce-order', 'party-registry'], refused: [] });
    expect(yield* readAs('commerce-order')).toBe('replacement-order-module-key');
    expect(yield* readAs('party-registry')).toBe(PARTY_KEY);
    expect(yield* readAs('pricing')).toBeUndefined();
  }),
);
