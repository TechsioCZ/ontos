import { Effect, Ref, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { ActionTransactionError } from '../../src/actions/errors.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { makeActionCompositionRevisionResolver } from '../../src/actions/runtime.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { makeApplicationCompositionSnapshotFixture } from '../../src/testing/module-contract.ts';

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'better-auth-session:release-test',
  authMethod: 'session',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
});

it.effect('never relabels an admitted gateway request after membership changes with the same receiving owner', () =>
  Effect.gen(function* rejectRelabelledRequest() {
    yield* TestClock.setTime(Date.parse('2026-10-02T16:00:00.000Z'));
    const first = yield* makeApplicationCompositionSnapshotFixture(['party-registry']);
    const replacement = yield* makeApplicationCompositionSnapshotFixture(['party-registry', 'inventory']);
    expect(first.composition.shell.deployment).toEqual(replacement.composition.shell.deployment);
    const active = yield* Ref.make(first);
    const resolve = makeActionCompositionRevisionResolver(
      { load: Ref.get(active) },
      first.composition.shell.deployment,
    );
    const admitted = trustVerifiedGatewayPrincipalContext(principal, first.composition.revision);
    expect(yield* resolve(admitted)).toBe(first.composition.revision);

    yield* Ref.set(active, replacement);
    const failure = yield* resolve(admitted).pipe(Effect.flip);
    expect(Schema.is(ActionTransactionError)(failure)).toBe(true);
    expect(yield* resolve(principal)).toBe(replacement.composition.revision);
  }),
);

it.effect('rejects an old owner artifact even when a cold process observes the new approved release', () =>
  Effect.gen(function* rejectOldOwnerArtifact() {
    yield* TestClock.setTime(Date.parse('2026-10-02T16:00:00.000Z'));
    const snapshot = yield* makeApplicationCompositionSnapshotFixture(['party-registry'], 'approved-build');
    const resolve = makeActionCompositionRevisionResolver(
      { load: Effect.succeed(snapshot) },
      { appId: 'party-registry', buildMarker: 'old-build' },
    );
    const failure = yield* resolve(principal).pipe(Effect.flip);
    expect(Schema.is(ActionTransactionError)(failure)).toBe(true);
  }),
);
