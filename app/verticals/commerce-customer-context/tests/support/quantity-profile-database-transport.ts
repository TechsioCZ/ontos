import { NodeSocket, NodeSocketServer } from '@effect/platform-node';
import { Effect, Exit, Redacted, Scope } from 'effect';
import { NetAddress } from 'effect/net';
import { Socket } from 'effect/socket';

const inspectionQuery = '"commerce_customer_context"."inspect_commerce_quantity_assignment_profile"';
const frameLimit = 16 * 1024 * 1024;

/** Bound protocol metadata only; neither statements nor authentication frames leave this closure. */
const makeInspectionSelector = () => {
  const statements = new Set<string>();
  const queryFrame = (frame: Buffer): boolean | undefined => {
    const simple = frame[0] === 81;
    const queryStart = simple ? 5 : frame.indexOf(0, 5) + 1;
    const queryEnd = frame.indexOf(0, queryStart);
    if (queryStart < 5 || queryEnd < queryStart) {
      return undefined;
    }
    const selected = frame.toString('utf-8', queryStart, queryEnd).includes(inspectionQuery);
    if (!simple) {
      const statement = frame.toString('utf-8', 5, queryStart - 1);
      statements.delete(statement);
      if (selected) {
        if (statements.size >= 256) {
          return undefined;
        }
        statements.add(statement);
      }
    }
    return selected;
  };
  const bindFrame = (frame: Buffer): boolean | undefined => {
    const statementStart = frame.indexOf(0, 5) + 1;
    const statementEnd = frame.indexOf(0, statementStart);
    return statementStart < 6 || statementEnd < statementStart
      ? undefined
      : statements.has(frame.toString('utf-8', statementStart, statementEnd));
  };
  return (frame: Buffer): boolean | undefined => {
    if (frame[0] === 81 || frame[0] === 80) {
      return queryFrame(frame);
    }
    return frame[0] === 66 ? bindFrame(frame) : false;
  };
};

/** Effect-owned native PostgreSQL relay; exactly one armed owner lookup loses its real connection. */
export const makeQuantityProfileDatabaseTransport = Effect.fn('QuantityProfileDatabaseTransport.make')(
  function* makeTransport(connectionString: Redacted.Redacted) {
    const source = new URL(Redacted.value(connectionString));
    const sslMode = source.searchParams.get('sslmode');
    if (!['localhost', '127.0.0.1'].includes(source.hostname) || (sslMode !== null && sslMode !== 'disable')) {
      return yield* Effect.die('Quantity wire fixture requires the existing unencrypted localhost test deployment');
    }
    let armed = false;
    let closed = false;
    let cutCount = 0;
    let matchedQueryCount = 0;
    const connections = new Set<Socket.Socket>();
    const transportScope = yield* Scope.make();
    const close = Scope.close(transportScope, Exit.void).pipe(
      Effect.timeout('2 seconds'),
      Effect.orDie,
      Effect.tap(() =>
        Effect.sync(() => {
          closed = true;
        }),
      ),
    );
    yield* Effect.addFinalizer(() => close);
    const server = yield* NodeSocketServer.make({ host: '127.0.0.1', port: 0 }).pipe(
      Scope.provide(transportScope),
      Effect.timeout('2 seconds'),
      Effect.orDie,
    );
    const { address } = server;
    if (!NetAddress.isInetAddress(address)) {
      return yield* Effect.die('Quantity wire fixture did not bind an owned TCP listener');
    }
    const relay = Effect.fn('QuantityProfileDatabaseTransport.relay')(function* relay(downstream: Socket.Socket) {
      return yield* Effect.scoped(
        Effect.gen(function* relayConnection() {
          connections.add(downstream);
          const upstream = yield* NodeSocket.makeNet({
            host: source.hostname,
            noDelay: true,
            openTimeout: '2 seconds',
            port: Number(source.port || '5432'),
          });
          const { downstreamPull, upstreamPull } = yield* Effect.all({
            downstreamPull: Socket.readerBytes(downstream),
            upstreamPull: Socket.readerBytes(upstream),
          });
          const { downstreamWriter, upstreamWriter } = yield* Effect.all({
            downstreamWriter: downstream.writer,
            upstreamWriter: upstream.writer,
          });
          const select = makeInspectionSelector();
          let frontend = Buffer.alloc(0);
          let startup = true;
          const forwardFrontend = Effect.gen(function* forwardFrontend() {
            while (true) {
              const chunks = yield* downstreamPull;
              for (const chunk of chunks) {
                if (frontend.length + chunk.length > frameLimit) {
                  return yield* Effect.die('Quantity wire fixture frontend buffer exceeded its bound');
                }
                frontend = Buffer.concat([frontend, chunk]);
                while (frontend.length >= (startup ? 4 : 5)) {
                  const length = startup ? frontend.readInt32BE(0) : frontend.readInt32BE(1) + 1;
                  if (length < (startup ? 8 : 5) || length > frameLimit) {
                    return yield* Effect.die('Invalid Quantity wire fixture frontend frame');
                  }
                  if (frontend.length < length) {
                    break;
                  }
                  const frame = frontend.subarray(0, length);
                  frontend = frontend.subarray(length);
                  let selected = false;
                  if (startup) {
                    startup = frame.readInt32BE(4) === 80_877_103;
                  } else {
                    const selection = select(frame);
                    if (selection === undefined) {
                      return yield* Effect.die('Invalid Quantity wire fixture selection frame');
                    }
                    selected = selection;
                  }
                  if (selected) {
                    matchedQueryCount += 1;
                  }
                  if (armed && selected) {
                    armed = false;
                    cutCount += 1;
                    return yield* Effect.void;
                  }
                  yield* upstreamWriter.write(frame);
                }
              }
            }
          });
          const forwardBackend = upstreamPull.pipe(
            Effect.flatMap((chunks) => downstreamWriter.writeAll(chunks)),
            Effect.forever,
          );
          yield* Effect.raceFirst(forwardFrontend, forwardBackend);
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            connections.delete(downstream);
          }),
        ),
        Effect.catchTag('SocketError', () => Effect.void),
      );
    });
    yield* server.run(relay).pipe(Effect.forkIn(transportScope));
    const routed = new URL(source);
    routed.hostname = '127.0.0.1';
    routed.port = String(address.port);
    return {
      arm: Effect.sync(() => {
        if (armed || closed || cutCount !== 0 || matchedQueryCount === 0) {
          throw new Error('Quantity wire fixture needs a genuine positive before its single outage');
        }
        armed = true;
      }),
      close,
      connectionString: Redacted.make(routed.toString()),
      observed: () => ({ activeSockets: connections.size * 2, cutCount, listenerOpen: !closed, matchedQueryCount }),
    };
  },
);
