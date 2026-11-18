import { v1 } from '@authzed/authzed-node';
import { Cause, Effect, Exit, Option } from 'effect';
import { expect, it, rstest } from 'effect-rstest';

import { makeAccessProjectionTransport } from '../../src/access/compiler/spice-db-compiler.ts';
import { projectionWriteViolation } from '../../src/access/intent/projection-write-error.ts';
import { SpiceDbRpcError } from '../../src/permissions/spicedb-rpc.ts';

const { read, write } = rstest.hoisted(() => ({ read: rstest.fn(), write: rstest.fn() }));
rstest.mock('../../src/permissions/spicedb-transport.node.ts', () => ({
  spiceDbTransport: { open: () => ({ close: () => {}, readRelationships: read, writeRelationships: write }) },
}));

it.effect('preserves RPC details, status name and operation through projection and worker cleanup errors', () =>
  Effect.gen(function* retainsTransportCause() {
    const cause = Object.assign(new Error('14 UNAVAILABLE: connection closed before response'), {
      code: 14,
      details: 'connection closed before response',
    });
    const rpcError = new SpiceDbRpcError({ cause, code: Option.some(14) });
    read.mockReturnValue(Effect.fail(rpcError));
    write.mockReturnValue(Effect.fail(rpcError));
    const transport = makeAccessProjectionTransport({ endpoint: 'localhost:50051', preSharedKey: 'test-only' });
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
      }
    }
  }),
);

it.effect('retains diagnostic causes without reclassifying permanent engine rejections', () =>
  Effect.gen(function* retainsPermanentRefusal() {
    const rpcError = new SpiceDbRpcError({ cause: new Error('invalid relationship'), code: Option.some(3) });
    write.mockReturnValue(Effect.fail(rpcError));
    const transport = makeAccessProjectionTransport({ endpoint: 'localhost:50051', preSharedKey: 'test-only' });
    const failure = yield* Effect.flip(transport.writeRelationships(v1.WriteRelationshipsRequest.create({})));
    expect(failure).toMatchObject({
      cause: rpcError,
      code: 'access_projection_engine_rejected',
      grpcStatus: 'INVALID_ARGUMENT',
      operation: 'WriteRelationships',
    });
  }),
);
