import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Effect, Fiber, Queue, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

export class PackagedNodeDependencyError extends Schema.TaggedError<PackagedNodeDependencyError>()(
  'PackagedNodeDependencyError',
  { message: Schema.String },
) {}

const failed = (message: string) => new PackagedNodeDependencyError({ message });
const SELF_CHECK_SPECIFIER = './node-dependency-self-check-missing.mjs';
const REQUEST_FIELDS = { parent: Schema.String, specifier: Schema.String };
const RESULT_FIELDS = {
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
};
const requestCodec = Schema.fromJsonString(Schema.Struct({ requests: Schema.Array(Schema.Struct(REQUEST_FIELDS)) }));
const responseCodec = Schema.fromJsonString(Schema.Struct({ results: Schema.Array(Schema.Struct(RESULT_FIELDS)) }));
const literal = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/**
 * One line is one wave's batch. Node keeps its native resolution caches between waves.
 * Use the tooling install's Schema, never a package in the output being verified.
 */
const RESOLVER_HOST = [
  `import { Schema } from ${literal(pathToFileURL(createRequire(import.meta.url).resolve('effect')).href)};`,
  "import { createInterface } from 'node:readline';",
  'const request = Schema.fromJsonString(Schema.Struct({ requests: Schema.Array(Schema.Struct({ parent: Schema.String, specifier: Schema.String })) }));',
  'const response = Schema.fromJsonString(Schema.Struct({ results: Schema.Array(Schema.Struct({ code: Schema.optionalKey(Schema.String), message: Schema.optionalKey(Schema.String), url: Schema.optionalKey(Schema.String) })) }));',
  'for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {',
  '  const { requests } = Schema.decodeUnknownSync(request)(line);',
  '  const results = requests.map(({ parent, specifier }) => {',
  '    try { return { url: import.meta.resolve(specifier, parent) }; }',
  "    catch (error) { return { code: String(error?.code ?? 'ERR_UNKNOWN'), message: String(error?.message ?? error) }; }",
  '  });',
  "  process.stdout.write(Schema.encodeSync(response)({ results }) + '\\n');",
  '}',
].join('\n');

export interface ResolverRequest {
  readonly parent: string;
  readonly specifier: string;
}

export interface ResolverResult {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly url?: string | undefined;
}

/** Successful immutable observations only; failures are retried rather than remembered. */
export const memoizeDependencyRead = <A, E, R>(read: (key: string) => Effect.Effect<A, E, R>) => {
  const values = new Map<string, A>();
  return Effect.fn('CompletePackagedNodeDependencies.memoizedRead')(function* memoizedRead(key: string) {
    const existing = values.get(key);
    if (existing !== undefined) {
      return yield* Effect.succeed(existing);
    }
    const value = yield* read(key);
    values.set(key, value);
    return yield* Effect.succeed(value);
  });
};

/** Scoped, sequential request stream: stdout, stderr and stdin are all drained concurrently. */
export const makePackagedDependencyResolver = Effect.fn('CompletePackagedNodeDependencies.makeResolver')(
  function* makeResolver(output: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const input = yield* Queue.unbounded<Uint8Array>();
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        ['--experimental-import-meta-resolve', '--input-type=module', '--eval', RESOLVER_HOST],
        { cwd: output, env: {}, stdin: Stream.fromQueue(input), stdout: 'pipe', stderr: 'pipe' },
      ),
    );
    const lines = yield* handle.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.toQueue({ capacity: 1 }));
    const stderr = yield* handle.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkScoped);
    const exchange = Effect.fn('CompletePackagedNodeDependencies.exchange')(function* exchange(
      requests: readonly ResolverRequest[],
    ) {
      const payload = yield* Schema.encodeEffect(requestCodec)({ requests }).pipe(
        Effect.mapError((cause) => failed(`the resolver request cannot be encoded: ${String(cause)}`)),
      );
      yield* Queue.offer(input, new TextEncoder().encode(`${payload}\n`));
      const line = yield* Queue.take(lines).pipe(
        Effect.mapError(() => failed('the Node resolver closed its response stream before answering')),
      );
      const response = yield* Schema.decodeUnknownEffect(responseCodec)(line).pipe(
        Effect.mapError((cause) => failed(`the Node resolver answered an unexpected shape: ${String(cause)}`)),
      );
      if (response.results.length !== requests.length) {
        return yield* Effect.fail(failed('the Node resolver answered a different number of requests than it received'));
      }
      return yield* Effect.succeed(response.results);
    });
    const parent = pathToFileURL(path.join(output, '.node-dependency-self-check.mjs')).href;
    const [probe] = yield* exchange([{ parent, specifier: SELF_CHECK_SPECIFIER }]);
    if (probe?.url !== new URL(SELF_CHECK_SPECIFIER, parent).href) {
      return yield* Effect.fail(
        failed('this Node does not honour --experimental-import-meta-resolve and its parent argument'),
      );
    }
    const results = new Map<string, ResolverResult>();
    const stats = { batches: 0, cacheHits: 0, requests: 0 };
    const resolve = Effect.fn('CompletePackagedNodeDependencies.resolve')(function* resolve(
      requests: readonly ResolverRequest[],
    ) {
      const pending = new Map<string, ResolverRequest>();
      for (const request of requests) {
        const key = `${request.parent}\0${request.specifier}`;
        if (results.has(key) || pending.has(key)) {
          stats.cacheHits += 1;
        } else {
          pending.set(key, request);
        }
      }
      if (pending.size > 0) {
        const answers = yield* exchange([...pending.values()]);
        stats.batches += 1;
        stats.requests += pending.size;
        let index = 0;
        for (const key of pending.keys()) {
          const answer = answers[index];
          if (answer === undefined) {
            return yield* Effect.fail(failed('the Node resolver omitted a requested answer'));
          }
          results.set(key, answer);
          index += 1;
        }
      }
      return yield* Effect.forEach(
        requests,
        (request) =>
          Effect.fromNullishOr(results.get(`${request.parent}\0${request.specifier}`)).pipe(
            Effect.mapError(() => failed('the Node resolver omitted a cached answer')),
          ),
        { concurrency: 1 },
      );
    });
    const close = Effect.gen(function* closeResolver() {
      yield* Queue.end(input);
      const [code, errors] = yield* Effect.all([handle.exitCode, Fiber.join(stderr)], { concurrency: 2 });
      if (Number(code) !== 0) {
        return yield* Effect.fail(failed(`the Node resolver exited ${Number(code)}: ${errors.trim()}`));
      }
      return yield* Effect.void;
    });
    return yield* Effect.succeed({ close, resolve, stats });
  },
);
