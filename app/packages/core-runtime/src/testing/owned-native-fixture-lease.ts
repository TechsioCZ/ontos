import { Effect, Schema } from 'effect';

import type { DatabaseConnectionPair } from '../db/config.ts';
import type { IsolatedNativeDatabaseError, OwnedNativeDatabaseExpectation } from './isolated-native-database.ts';

type VerifyOwnedFixture = (
  expected: OwnedNativeDatabaseExpectation,
) => Effect.Effect<void, IsolatedNativeDatabaseError>;

const ownedFixtureMint = Symbol('OwnedNativeDatabaseFixture.mint');

export interface OwnedNativeDatabaseFixtureIdentity {
  readonly connections: DatabaseConnectionPair;
  readonly ownedNativeDatabaseLease?: OwnedFixtureLease;
}

class OwnedFixtureLease {
  readonly #verification: {
    readonly owner: OwnedNativeDatabaseFixtureIdentity;
    readonly verify: VerifyOwnedFixture;
  } | null;

  constructor(mint: symbol, owner: OwnedNativeDatabaseFixtureIdentity, verify: VerifyOwnedFixture) {
    this.#verification = mint === ownedFixtureMint ? Object.freeze({ owner, verify }) : null;
    Object.freeze(this);
  }

  static verify(
    candidate: OwnedFixtureLease,
    fixture: OwnedNativeDatabaseFixtureIdentity,
    expected: OwnedNativeDatabaseExpectation,
    refused: () => IsolatedNativeDatabaseError,
  ) {
    if (!(#verification in candidate)) {
      return Effect.fail(refused());
    }
    const verification = candidate.#verification;
    return verification !== null && verification.owner === fixture
      ? verification.verify(expected)
      : Effect.fail(refused());
  }
}

const OwnedFixtureLeaseSchema = Schema.instanceOf(OwnedFixtureLease);

/** The owner-local cloner is the only public fixture API that can mint this private lease. */
export const attachOwnedNativeFixtureLease = (
  fixture: OwnedNativeDatabaseFixtureIdentity,
  verify: VerifyOwnedFixture,
) =>
  Object.defineProperty(fixture, 'ownedNativeDatabaseLease', {
    value: new OwnedFixtureLease(ownedFixtureMint, fixture, verify),
  });

export const verifyOwnedNativeFixtureLease = (
  fixture: OwnedNativeDatabaseFixtureIdentity,
  expected: OwnedNativeDatabaseExpectation,
  refused: () => IsolatedNativeDatabaseError,
) => {
  const candidate = fixture.ownedNativeDatabaseLease;
  return Schema.is(OwnedFixtureLeaseSchema)(candidate)
    ? OwnedFixtureLease.verify(candidate, fixture, expected, refused)
    : Effect.fail(refused());
};
