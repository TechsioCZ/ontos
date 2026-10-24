import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const continuationModule = fileURLToPath(
  new URL(
    '../../verticals/commerce-customer-context/api/portal-auth/enrollment/request-continuation.ts',
    import.meta.url,
  ),
);

// The real BFF request-services lifecycle and real workerd KV I/O, not a resident Node process.
// Delayed owner work must finish before the response and before its service scope is disposed.
const workerSource = `
import { env } from 'cloudflare:workers';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { createHttpApiHandler, HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from '@modern-js/bff-effect/effect-edge';
import { advanceEnrollmentWithinRequest } from ${JSON.stringify(continuationModule)};

class Journal extends Context.Service()('enrollment-request-test/Journal') {}
const projection = Schema.Struct({ ownerCalls: Schema.Number, revision: Schema.Number, state: Schema.String });
const initial = { state: 'IN_PROGRESS', revision: 1, ownerCalls: 0 };
const services = Layer.effect(Journal, Effect.acquireRelease(
  Effect.sync(() => {
    let open = true;
    const read = Effect.promise(async () => JSON.parse((await env.JOURNAL.get('attempt')) ?? JSON.stringify(initial)));
    return {
      close: () => { open = false; },
      read,
      advance: (state, refuse = false) => Effect.gen(function* () {
        yield* Effect.sleep('25 millis');
        if (!open) return yield* Effect.die('request services were disposed before owner work');
        if (refuse) return yield* Effect.fail('owner temporarily unavailable');
        const previous = yield* read;
        yield* Effect.promise(() => env.JOURNAL.put('attempt', JSON.stringify({
          state, revision: previous.revision + 1, ownerCalls: previous.ownerCalls + 1,
        })));
        return Option.some(state === 'COMPLETE'
          ? { outcome: 'COMPLETE' }
          : { outcome: 'HALTED', halt: { reason: 'VERIFICATION_REQUIRED', transition: Option.none() } });
      }),
    };
  }),
  (journal) => Effect.sync(journal.close),
));
const api = HttpApi.make('EnrollmentRequestProof').add(HttpApiGroup.make('enrollment')
  .add(HttpApiEndpoint.post('start', '/start', { success: projection }))
  .add(HttpApiEndpoint.post('resume', '/resume', { success: projection }))
  .add(HttpApiEndpoint.post('unavailable', '/unavailable', { success: projection }))
  .add(HttpApiEndpoint.get('current', '/current', { success: projection })));
const advance = (state, refuse = false) => Effect.gen(function* () {
  const journal = yield* Journal;
  yield* advanceEnrollmentWithinRequest(journal.advance(state, refuse), 'fixture-attempt');
  return yield* journal.read;
});
const handlers = HttpApiBuilder.group(api, 'enrollment', (handlers) => handlers
  .handle('start', () => advance('VERIFICATION_REQUIRED'))
  .handle('resume', () => advance('COMPLETE'))
  .handle('unavailable', () => advance('COMPLETE', true))
  .handle('current', () => Journal.pipe(Effect.flatMap((journal) => journal.read))));
const runtime = createHttpApiHandler({ api, layer: HttpApiBuilder.layer(api).pipe(Layer.provide(handlers)), services, servicesLifetime: 'request' });
export default { fetch(request, _env, ctx) {
  return runtime.handler(request, { waitUntil: (promise) => ctx.waitUntil(promise) });
} };
`;

const ProjectionSchema = Schema.Struct({ ownerCalls: Schema.Number, revision: Schema.Number, state: Schema.String });

const withWorker = Effect.gen(function* createWorker() {
  const bundle = yield* Effect.promise(() =>
    build({
      bundle: true,
      conditions: ['workerd', 'worker', 'import'],
      external: ['cloudflare:*', 'node:*'],
      format: 'esm',
      platform: 'neutral',
      stdin: { contents: workerSource, loader: 'js', resolveDir: import.meta.dirname },
      write: false,
    }),
  );
  return yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Miniflare(
          convertV4MiniflareOptions({
            compatibilityDate: '2026-06-02',
            compatibilityFlags: ['nodejs_compat'],
            kvNamespaces: ['JOURNAL'],
            modules: true,
            script: bundle.outputFiles[0]?.text ?? '',
          }),
        ),
    ),
    (worker) => Effect.promise(() => worker.dispose()),
  );
});

const request = (worker: Miniflare, path: string, method = 'POST') =>
  Effect.gen(function* readProjection() {
    const response = yield* Effect.promise(() => worker.dispatchFetch(`https://fixture.invalid${path}`, { method }));
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(ProjectionSchema)(yield* Effect.promise(() => response.json()));
  });

it.live('start and resume finish owner I/O and reread before request services close, without a resident sweeper', () =>
  Effect.gen(function* requestOwnedEnrollment() {
    const worker = yield* withWorker;
    const parked = { ownerCalls: 1, revision: 2, state: 'VERIFICATION_REQUIRED' };
    expect(yield* request(worker, '/start')).toEqual(parked);
    expect(yield* request(worker, '/current', 'GET')).toEqual(parked);
    const complete = { ownerCalls: 2, revision: 3, state: 'COMPLETE' };
    expect(yield* request(worker, '/resume')).toEqual(complete);
    expect(yield* request(worker, '/current', 'GET')).toEqual(complete);
  }).pipe(Effect.scoped),
);

it.live('an owner failure preserves committed evidence and leaves recovery to a later explicit request', () =>
  Effect.gen(function* interruptedEnrollment() {
    const worker = yield* withWorker;
    const parked = yield* request(worker, '/start');
    expect(yield* request(worker, '/unavailable')).toEqual(parked);
    expect(yield* request(worker, '/current', 'GET')).toEqual(parked);
    expect(yield* request(worker, '/resume')).toEqual({ ownerCalls: 2, revision: 3, state: 'COMPLETE' });
  }).pipe(Effect.scoped),
);
