import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Duration, Effect, Exit, Layer, Option, Predicate, Ref } from 'effect';
import { expect, it } from 'effect-rstest';

import { openSpiceDbGrpcRpc } from '../../src/permissions/spicedb-grpc-rpc.ts';
import type { SpiceDbRpc, SpiceDbRpcError } from '../../src/permissions/spicedb-rpc.ts';
import { ScriptedSpiceDbUnavailable, serveRecordingSpiceDb } from '../support/native-spicedb-grpc.ts';
import type { RecordedSpiceDbMethod } from '../support/native-spicedb-grpc.ts';

const PRE_SHARED_KEY = 'refused-stream-key';
const GRPC_UNAVAILABLE = 14;
const REFUSED_STREAM = 'Write error: Stream closed with error code NGHTTP2_REFUSED_STREAM';

/** Node's services for one test, built and released with it. */
const onNode = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Layer.build(NodeServices.layer).pipe(
    Effect.flatMap((nodeServices) => body.pipe(Effect.provide(nodeServices))),
    Effect.scoped,
  );

const answered = () => Effect.void;
const unavailable = () => Effect.fail(new ScriptedSpiceDbUnavailable({ details: 'scripted unavailable' }));

const openRpc = (standIn: { readonly caCertificate: string; readonly endpoint: string }, timeoutMilliseconds: number) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      openSpiceDbGrpcRpc(
        { caCertificate: standIn.caCertificate, endpoint: standIn.endpoint, preSharedKey: PRE_SHARED_KEY },
        timeoutMilliseconds,
      ),
    ),
    (rpc) => Effect.sync(() => rpc.close()),
  );

/** Every SpiceDbRpc call by its gRPC method, each with an empty request. */
const calls = (
  rpc: SpiceDbRpc,
): readonly (readonly [RecordedSpiceDbMethod, Effect.Effect<void, SpiceDbRpcError>])[] => [
  ['CheckPermission', Effect.asVoid(rpc.checkPermission(v1.CheckPermissionRequest.create({})))],
  ['CheckBulkPermissions', Effect.asVoid(rpc.checkBulkPermissions(v1.CheckBulkPermissionsRequest.create({})))],
  ['ReadRelationships', Effect.asVoid(rpc.readRelationships(v1.ReadRelationshipsRequest.create({})))],
  ['WriteRelationships', Effect.asVoid(rpc.writeRelationships(v1.WriteRelationshipsRequest.create({})))],
  ['WriteSchema', Effect.asVoid(rpc.writeSchema(v1.WriteSchemaRequest.create({ schema: '' })))],
];
const isRead = (method: RecordedSpiceDbMethod) => !method.startsWith('Write');

/** The gRPC status a call ended with, as the caller sees it: OK (0), or the code and details of its failure. */
const statusOf = (exit: Exit.Exit<void, SpiceDbRpcError>) =>
  Option.match(Exit.findErrorOption(exit), {
    onNone: () => ({ code: Exit.isSuccess(exit) ? 0 : null, details: null }),
    onSome: (failure) => ({
      code: Option.getOrNull(failure.code),
      details:
        Predicate.hasProperty(failure.cause, 'details') && Predicate.isString(failure.cause.details)
          ? failure.cause.details
          : null,
    }),
  });

/**
 * Sends `call` in the event-loop turn in which SpiceDB's GOAWAY is on the wire but not yet read: the client queues
 * the call on the old connection, reads the GOAWAY, and refuses the unsent stream itself. SpiceDB opens this window
 * on every connection once per `--grpc-max-conn-age` (30 s by default).
 */
const callWhileConnectionRecycles = (
  recycleConnections: Effect.Effect<void>,
  call: Effect.Effect<void, SpiceDbRpcError>,
) => recycleConnections.pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.exit(call)));

it.live(
  'answers a read that SpiceDB connection recycling refused on the next connection, and never resends a write',
  () =>
    Effect.gen(function* refusedStreams() {
      const spiceDb = yield* serveRecordingSpiceDb(PRE_SHARED_KEY, answered);
      const rpc = yield* openRpc(spiceDb, 2000);
      for (const [method, call] of calls(rpc)) {
        yield* call;
        spiceDb.received.length = 0;
        const exit = yield* callWhileConnectionRecycles(spiceDb.recycleConnections, call);
        // A read reaches SpiceDB once, on the new connection. A refused write is reported unavailable and left to
        // its caller: the client cannot tell this write error from a write SpiceDB applied.
        expect({ method, received: spiceDb.received, status: statusOf(exit) }).toEqual(
          isRead(method)
            ? { method, received: [method], status: { code: 0, details: null } }
            : { method, received: [], status: { code: GRPC_UNAVAILABLE, details: REFUSED_STREAM } },
        );
      }
      const denial = yield* rpc.checkPermission(v1.CheckPermissionRequest.create({}));
      expect(denial.permissionship).toBe(v1.CheckPermissionResponse_Permissionship.NO_PERMISSION);
    }).pipe(onNode),
  { timeout: 10_000 },
);

it.live(
  'sends a write SpiceDB answered unavailable exactly once, and fails a read SpiceDB keeps refusing closed',
  () =>
    Effect.gen(function* unavailableAnswers() {
      const spiceDb = yield* serveRecordingSpiceDb(PRE_SHARED_KEY, unavailable);
      const rpc = yield* openRpc(spiceDb, 2000);
      for (const [method, call] of calls(rpc)) {
        spiceDb.received.length = 0;
        const exit = yield* Effect.exit(call);
        expect({ method, received: spiceDb.received, status: statusOf(exit) }).toEqual({
          method,
          received: isRead(method) ? [method, method, method] : [method],
          status: { code: GRPC_UNAVAILABLE, details: 'scripted unavailable' },
        });
      }
    }).pipe(onNode),
  { timeout: 10_000 },
);

it.live(
  'ends a retried read at the call deadline: a retry gets what is left of it, not a new one',
  () =>
    Effect.gen(function* boundedByDeadline() {
      const answers = yield* Ref.make(0);
      // The first attempt is refused at once; the retry is never answered.
      const spiceDb = yield* serveRecordingSpiceDb(PRE_SHARED_KEY, () =>
        Ref.getAndUpdate(answers, (count) => count + 1).pipe(
          Effect.flatMap((count) => (count === 0 ? unavailable() : Effect.never)),
        ),
      );
      const rpc = yield* openRpc(spiceDb, 200);
      const [elapsed, exit] = yield* Effect.timed(
        Effect.exit(rpc.checkPermission(v1.CheckPermissionRequest.create({}))),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Duration.toMillis(elapsed)).toBeLessThan(400);
      expect(spiceDb.received).toEqual(['CheckPermission', 'CheckPermission']);
    }).pipe(onNode),
  { timeout: 10_000 },
);
