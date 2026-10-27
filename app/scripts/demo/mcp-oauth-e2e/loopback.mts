import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Effect, Option, Predicate, Schema } from 'effect';

export class LoopbackFailure extends Schema.TaggedError<LoopbackFailure>()('LoopbackFailure', {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}

const ListenerNotRunningSchema = Schema.Struct({ code: Schema.Literal('ERR_SERVER_NOT_RUNNING') });
type CallbackWaiter = (result: Effect.Effect<URLSearchParams, LoopbackFailure>) => void;
const unregisterWaiter = (waiters: Set<CallbackWaiter>, resume: CallbackWaiter) =>
  Effect.sync(() => {
    waiters.delete(resume);
  });
type CompleteListener = (effect: Effect.Effect<void, LoopbackFailure>) => void;

const listenServer = (server: Server) =>
  Effect.callback((resume: CompleteListener) => {
    const handlers = {
      error: (cause: Error): void => {
        server.off('listening', handlers.listening);
        resume(Effect.fail(new LoopbackFailure({ cause, message: 'OAuth callback listener failed to start' })));
      },
      listening: (): void => {
        server.off('error', handlers.error);
        resume(Effect.void);
      },
    };
    server.once('error', handlers.error);
    server.once('listening', handlers.listening);
    server.listen({ host: '::', ipv6Only: false, port: 0 });
    return Effect.sync(() => {
      server.off('error', handlers.error);
      server.off('listening', handlers.listening);
    });
  });

export interface LoopbackCallback {
  readonly close: Effect.Effect<void, LoopbackFailure>;
  /** http://localhost:<random port>/callback */
  readonly redirectUrl: string;
  readonly waitForCallback: (timeoutMs: number) => Effect.Effect<URLSearchParams, LoopbackFailure>;
}

/** One-shot OAuth listener. Node callbacks only resume the waiting Effect fiber. */
export const startLoopbackCallback = () =>
  Effect.gen(function* startCallbackListener() {
    let received = Option.none<URLSearchParams>();
    let failure = Option.none<LoopbackFailure>();
    let closed = false;
    const waiters = new Set<CallbackWaiter>();
    const server = createServer((req, res) => {
      const target = req.url ?? '/';
      if (!URL.canParse(target, 'http://localhost')) {
        res.writeHead(400).end();
        return;
      }
      const url = new URL(target, 'http://localhost');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html lang="cs"><meta charset="utf-8"><title>OntOS</title><p>Připojení dokončeno. Okno můžete zavřít.</p></html>',
      );
      if (Option.isSome(received)) {
        return;
      }
      received = Option.some(url.searchParams);
      for (const resume of waiters) {
        resume(Effect.succeed(url.searchParams));
      }
      waiters.clear();
    });
    const onServerError = (cause: Error): void => {
      const error = new LoopbackFailure({ cause, message: 'OAuth callback listener failed' });
      failure = Option.some(error);
      for (const resume of waiters) {
        resume(Effect.fail(error));
      }
      waiters.clear();
    };
    server.on('error', onServerError);

    const close: Effect.Effect<void, LoopbackFailure> = Effect.uninterruptible(
      Effect.callback((resume: CompleteListener) => {
        if (closed) {
          resume(Effect.void);
          return;
        }
        closed = true;
        const error = new LoopbackFailure({ message: 'OAuth callback listener closed' });
        for (const waiter of waiters) {
          waiter(Effect.fail(error));
        }
        waiters.clear();
        server.closeAllConnections();
        server.close((cause) => {
          server.off('error', onServerError);
          // Closing an unbound or already closed listener is idempotent.
          resume(
            cause === undefined || Schema.is(ListenerNotRunningSchema)(cause)
              ? Effect.void
              : Effect.fail(new LoopbackFailure({ cause, message: 'OAuth callback listener close failed' })),
          );
        });
      }),
    );

    yield* listenServer(server).pipe(Effect.onError(() => close.pipe(Effect.orDie)));
    const address = server.address();
    if (address === null || Predicate.isString(address)) {
      return yield* Effect.fail(new LoopbackFailure({ message: 'OAuth callback listener has no TCP address' })).pipe(
        Effect.ensuring(close.pipe(Effect.orDie)),
      );
    }
    const callback: LoopbackCallback = {
      close,
      redirectUrl: `http://localhost:${address.port}/callback`,
      waitForCallback: (timeoutMs) =>
        Effect.callback<URLSearchParams, LoopbackFailure>((resume) => {
          if (Option.isSome(received)) {
            resume(Effect.succeed(received.value));
          } else if (Option.isSome(failure)) {
            resume(Effect.fail(failure.value));
          } else if (closed) {
            resume(Effect.fail(new LoopbackFailure({ message: 'OAuth callback listener closed' })));
          } else {
            waiters.add(resume);
          }
          return unregisterWaiter(waiters, resume);
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
              Effect.fail(new LoopbackFailure({ message: `OAuth callback did not arrive within ${timeoutMs} ms` })),
          }),
        ),
    };
    return callback;
  });
