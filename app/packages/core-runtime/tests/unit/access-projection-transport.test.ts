import { v1 } from '@authzed/authzed-node';
import { Cause, Effect, Exit, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { accessProjectionTransport } from '../../src/access/compiler/spice-db-compiler.ts';
import { projectionWriteViolation } from '../../src/access/intent/projection-write-error.ts';
import { SpiceDbRpcError } from '../../src/permissions/spicedb-rpc.ts';

/** An opened SpiceDB RPC whose every relationship call ends in the given transport failure. */
const failingRpc = (failure: SpiceDbRpcError) => ({
  close: () => {},
  readRelationships: () => Effect.fail(failure),
  writeRelationships: () => Effect.fail(failure),
});

it.effect('preserves RPC details, status name and operation through projection and worker cleanup errors', () =>
  Effect.gen(function* retainsTransportCause() {
    const cause = Object.assign(new Error('14 UNAVAILABLE: connection closed before response'), {
      code: 14,
      details: 'connection closed before response',
    });
    const rpcError = new SpiceDbRpcError({ cause, code: Option.some(14) });
    const rpc = failingRpc(rpcError);
    const transport = accessProjectionTransport(rpc);
    for (const [operation, call] of [
      ['ReadRelationships', transport.readRelationships(v1.ReadRelationshipsRequest.create({})).pipe(Effect.asVoid)],
      ['WriteRelationships', transport.writeRelationships(v1.WriteRelationshipsRequest.create({})).pipe(Effect.asVoid)],
    ] as const) {
      const failure = yield* Effect.flip(call);
      expect(failure).toMatchObject({
        cause: { cause: { details: 'connection closed before response' } },
        code: 'access_projection_unavailable',
        grpcStatus: 'UNAVAILABLE',
        operation,
      });
      const wrapped = projectionWriteViolation('access_projection_write_unavailable', [failure.reason], failure);
      expect(wrapped.cause).toBe(failure);
      const exit = yield* Effect.scoped(Effect.addFinalizer(() => Effect.fail(wrapped).pipe(Effect.orDie))).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain('connection closed before response');
        expect(Cause.pretty(exit.cause)).toContain(operation);
        expect(Cause.pretty(exit.cause)).toContain('UNAVAILABLE');
      }
    }
  }),
);

it.effect('retains diagnostic causes without reclassifying permanent engine rejections', () =>
  Effect.gen(function* retainsPermanentRefusal() {
    const rpcError = new SpiceDbRpcError({ cause: new Error('invalid relationship'), code: Option.some(3) });
    const rpc = failingRpc(rpcError);
    const transport = accessProjectionTransport(rpc);
    const failure = yield* Effect.flip(transport.writeRelationships(v1.WriteRelationshipsRequest.create({})));
    expect(failure).toMatchObject({
      cause: rpcError,
      code: 'access_projection_engine_rejected',
      grpcStatus: 'INVALID_ARGUMENT',
      operation: 'WriteRelationships',
    });
  }),
);
