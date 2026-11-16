import { v1 } from '@authzed/authzed-node';
import { Clock, Duration, Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { ACCESS_PROJECTION_RPC_TIMEOUT_MS } from '../../src/access/compiler/spice-db-compiler.ts';
import { ACCESS_FENCE_HOLD_UNPROVED_LIMIT } from '../../src/access/intent/projection-writer.ts';
import { ACCESS_FENCE_LEASE } from '../../src/access/lifecycle/fence.ts';
import { spiceDbGrpcCallOptions } from '../../src/permissions/spicedb-grpc-rpc.ts';

/*
 * A take-over waits for the previous holder's lease. That is only safe if, by the time the lease can lapse, no engine
 * call that holder sent can still be accepted: every call carries a deadline the engine enforces, and the deadline is
 * shorter than the time between a holder's last proof of its hold and its lease lapsing.
 */
it('keeps the engine deadline below the lease minus the unproved-hold limit', () => {
  const lease = Duration.toMillis(ACCESS_FENCE_LEASE);
  const unproved = Duration.toMillis(ACCESS_FENCE_HOLD_UNPROVED_LIMIT);
  expect(unproved).toBeLessThan(lease);
  // RPC deadline 15 s < lease 120 s − limit 90 s = 30 s.
  expect(ACCESS_PROJECTION_RPC_TIMEOUT_MS).toBeLessThan(lease - unproved);
});

/** The engine write as gRPC describes it: the call the projection sends. */
const writeRelationshipsMethod = {
  path: '/authzed.api.v1.PermissionsService/WriteRelationships',
  requestSerialize: (value: v1.WriteRelationshipsRequest) => Buffer.from(v1.WriteRelationshipsRequest.toBinary(value)),
  requestStream: false,
  responseDeserialize: (bytes: Buffer) => v1.WriteRelationshipsResponse.fromBinary(bytes),
  responseStream: false,
};

it.live('gives every gRPC call of the projection a deadline of its own timeout', () =>
  Effect.gen(function* deadlineOnEveryCall() {
    const [interceptor] = spiceDbGrpcCallOptions(ACCESS_PROJECTION_RPC_TIMEOUT_MS).interceptors ?? [];
    const before = yield* Clock.currentTimeMillis;
    const captured: unknown[] = [];
    // The interceptor sets the deadline before it hands the call on; the hand-over itself is stopped here.
    expect(() =>
      interceptor?.({ method_definition: writeRelationshipsMethod }, (next) => {
        captured.push(next.deadline);
        throw new Error('stop');
      }),
    ).toThrow('stop');
    const after = yield* Clock.currentTimeMillis;
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBeGreaterThanOrEqual(before + ACCESS_PROJECTION_RPC_TIMEOUT_MS);
    expect(captured[0]).toBeLessThanOrEqual(after + ACCESS_PROJECTION_RPC_TIMEOUT_MS);
  }),
);
