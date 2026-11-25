#!/usr/bin/env node
/** Four GET-only acceptance checks. Importing this module reads no key and performs no network I/O. */
import { randomUUID } from 'node:crypto';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { GatewayAuthenticationRequiredProblemSchema } from '@app/shared-contracts';
import { Cause, Console, Effect, FileSystem, Option, Redacted, Schema, Stdio } from 'effect';
import { CliError, Command, Flag } from 'effect/cli';

import {
  SymmyDemoOrderNotFoundProblemSchema,
  SymmyDemoOrdersResponseSchema,
} from '../../apps/shell-super-app/api/symmy/demo-orders-contract.ts';

/** Symmy is served by the shared stage Shell, not the AKROS storefront or the N1 application. */
export const AKROS_SYMMY_STAGE_ORIGIN = 'https://ontos-stage.web-revolution.cz';
const prefix = '/api/symmy/v1';
const maxResponseBytes = 1_000_000;
const checks = {
  catalogRevisionUnauthenticated: 'catalog-revision-unauthenticated',
  configuration: 'configuration',
  missingOrder: 'missing-order',
  ordersList: 'orders-list',
  ordersUnauthenticated: 'orders-unauthenticated',
} as const;
const CheckSchema = Schema.Literals(Object.values(checks));
type Check = typeof CheckSchema.Type;
export class SymmyNegativeProofFailure extends Schema.TaggedError<SymmyNegativeProofFailure>()(
  'SymmyNegativeProofFailure',
  {
    check: CheckSchema,
    reason: Schema.Literals([
      'invalid_arguments',
      'wrong_origin',
      'key_file_unreadable',
      'invalid_key',
      'invalid_selector',
      'network_failed',
      'redirect_refused',
      'unexpected_status',
      'response_invalid',
      'orders_empty',
    ]),
    status: Schema.optionalKey(Schema.Int),
  },
) {}

export interface SymmyNegativeProofConfig {
  readonly apiKey: Redacted.Redacted;
  readonly origin: string;
}
export interface SymmyNegativeProofArguments {
  readonly keyFile: string;
  readonly origin: string;
}
const fail = (check: Check, reason: typeof SymmyNegativeProofFailure.prototype.reason, status?: number) =>
  new SymmyNegativeProofFailure(status === undefined ? { check, reason } : { check, reason, status });

export const checkedNegativeProofOrigin = (origin: string) =>
  // Exact comparison also refuses credentials, alternate hosts, paths, ports, queries and fragments.
  origin === AKROS_SYMMY_STAGE_ORIGIN
    ? Effect.succeed(origin)
    : Effect.fail(fail(checks.configuration, 'wrong_origin'));

const ArgumentsSchema = Schema.Tuple([
  Schema.Literal('--run'),
  Schema.Literal('--origin'),
  Schema.String,
  Schema.Literal('--key-file'),
  Schema.String.check(Schema.isPattern(/\S/u)),
]);
/** Explicit --run plus origin and a file path; no key value is accepted on argv or from an environment default. */
export const parseSymmyNegativeProofArguments = Effect.fn('SymmyNegativeProof.arguments')(function* parse(
  argv: readonly string[],
) {
  const parsed = yield* Schema.decodeUnknownEffect(ArgumentsSchema)(argv).pipe(
    Effect.mapError(() => fail(checks.configuration, 'invalid_arguments')),
  );
  return { keyFile: parsed[4], origin: yield* checkedNegativeProofOrigin(parsed[2]) };
});

const hasForbiddenKeyCharacter = (key: string): boolean => {
  for (let index = 0; index < key.length; index += 1) {
    const code = key.codePointAt(index) ?? 0;
    if (code <= 32 || code === 127) {
      return true;
    }
  }
  return false;
};

/** Called only after explicit run arguments have been validated. File contents and I/O errors never reach output. */
export const loadSymmyNegativeProofConfig = Effect.fn('SymmyNegativeProof.config')(function* load(
  args: SymmyNegativeProofArguments,
) {
  const origin = yield* checkedNegativeProofOrigin(args.origin);
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs
    .readFileString(args.keyFile, 'utf-8')
    .pipe(Effect.mapError(() => fail(checks.configuration, 'key_file_unreadable')));
  const key = contents.trim();
  if (key.length === 0 || key.length > 4096 || hasForbiddenKeyCharacter(key)) {
    return yield* fail(checks.configuration, 'invalid_key');
  }
  return { apiKey: Redacted.make(key), origin };
});

const cancelResponse = (response: Response) =>
  Effect.promise(async () => {
    await response.body?.cancel();
  });

const readBoundedJson = <A,>(response: Response, check: Check, schema: Schema.Codec<A, Schema.Json>) =>
  Effect.gen(function* read() {
    let completed = false;
    const readBody = Effect.fn('SymmyNegativeProof.readBody')(function* consume(
      reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
    ) {
      if (reader === undefined) {
        return yield* fail(check, 'response_invalid', response.status);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = yield* Effect.tryPromise({
          catch: () => fail(check, 'response_invalid', response.status),
          try: async () => await reader.read(),
        });
        if (part.done) {
          completed = true;
          break;
        }
        size += part.value.byteLength;
        if (size > maxResponseBytes) {
          return yield* fail(check, 'response_invalid', response.status);
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes)).pipe(
        Effect.mapError(() => fail(check, 'response_invalid', response.status)),
      );
    });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => response.body?.getReader()),
      readBody,
      (reader) => {
        if (reader === undefined) {
          return Effect.void;
        }
        return (
          completed
            ? Effect.void
            : Effect.tryPromise({
                catch: () => fail(check, 'response_invalid', response.status),
                try: async () => {
                  await reader.cancel();
                },
              })
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              reader.releaseLock();
            }),
          ),
        );
      },
    );
  });

const validateOrdersPage = Effect.fn('SymmyNegativeProof.ordersPage')(function* validate(
  page: typeof SymmyDemoOrdersResponseSchema.Type,
  missingId: string,
  status: number,
) {
  if (page.orders.length === 0 || page.count === 0) {
    yield* fail(checks.ordersList, 'orders_empty', status);
  }
  if (
    page.limit !== 1 ||
    page.offset !== 0 ||
    page.orders.length !== 1 ||
    page.count < page.orders.length ||
    page.orders.some((order) => order.id === missingId || order.customerId !== order.partyId)
  ) {
    yield* fail(checks.ordersList, 'response_invalid', status);
  }
});

export type SymmyNegativeProofFetch = (input: string, init: RequestInit) => Effect.Effect<Response, Error>;

/** Never places orders or calls any write endpoint. Output contains fixed check names and numeric statuses only. */
export const runSymmyNegativeProof = Effect.fn('SymmyNegativeProof.run')(function* run(
  config: SymmyNegativeProofConfig,
  options: {
    readonly fetch?: SymmyNegativeProofFetch;
    readonly newOrderId?: () => string;
    readonly writeLine?: (line: string) => Effect.Effect<void>;
  } = {},
) {
  const origin = yield* checkedNegativeProofOrigin(config.origin);
  const fetchRequest: SymmyNegativeProofFetch =
    options.fetch ??
    ((input, init) =>
      Effect.tryPromise({
        catch: () => new Error('The proof request failed'),
        try: async (signal) =>
          await fetch(input, { ...init, signal: AbortSignal.any([signal, init.signal ?? signal]) }),
      }));
  const missingId = (options.newOrderId ?? randomUUID)();
  if (!Schema.is(Schema.String.check(Schema.isUUID()))(missingId)) {
    yield* fail(checks.configuration, 'invalid_selector');
  }
  const request = Effect.fn('SymmyNegativeProof.request')(function* request(
    check: Check,
    path: string,
    authenticated: boolean,
    expectedStatus: number,
  ) {
    const response = yield* fetchRequest(`${origin}${prefix}${path}`, {
      cache: 'no-store',
      credentials: 'omit',
      headers: authenticated
        ? { accept: 'application/json', 'x-api-key': Redacted.value(config.apiKey) }
        : { accept: 'application/json' },
      method: 'GET',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(15_000),
    }).pipe(Effect.mapError(() => fail(check, 'network_failed')));
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      yield* cancelResponse(response);
      return yield* fail(check, 'redirect_refused', response.status);
    }
    if (response.status !== expectedStatus) {
      yield* cancelResponse(response);
      return yield* fail(check, 'unexpected_status', response.status);
    }
    return response;
  });
  for (const { authenticated, check, path, status } of [
    { authenticated: false, check: checks.ordersUnauthenticated, path: '/orders', status: 401 },
    { authenticated: false, check: checks.catalogRevisionUnauthenticated, path: '/catalog/revision', status: 401 },
    { authenticated: true, check: checks.missingOrder, path: `/orders/${missingId}`, status: 404 },
  ]) {
    const response = yield* request(check, path, authenticated, status);
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (
      mime !== 'application/problem+json' ||
      (!authenticated && response.headers.get('www-authenticate') !== 'ApiKey realm="ontos-gateway"')
    ) {
      yield* cancelResponse(response);
      yield* fail(check, 'response_invalid', response.status);
    }
    const expectedProblem =
      check === checks.missingOrder ? SymmyDemoOrderNotFoundProblemSchema : GatewayAuthenticationRequiredProblemSchema;
    yield* readBoundedJson<
      typeof SymmyDemoOrderNotFoundProblemSchema.Type | typeof GatewayAuthenticationRequiredProblemSchema.Type
    >(response, check, expectedProblem);
    yield* options.writeLine?.(`PASS ${check} status=${String(response.status)}`) ?? Effect.void;
  }
  const response = yield* request(checks.ordersList, '/orders?limit=1&offset=0', true, 200);
  const page = yield* readBoundedJson(response, checks.ordersList, SymmyDemoOrdersResponseSchema);
  yield* validateOrdersPage(page, missingId, response.status);
  yield* options.writeLine?.('PASS orders-list status=200') ?? Effect.void;
});

export const symmyNegativeProofFailureLine = (error: Error): string =>
  Schema.is(SymmyNegativeProofFailure)(error)
    ? `FAIL ${error.check} status=${error.status === undefined ? 'none' : String(error.status)} reason=${error.reason}`
    : 'FAIL configuration status=none reason=unexpected_failure';

const command = Command.make(
  'stage-symmy-negative-proof',
  {
    keyFile: Flag.String('key-file'),
    origin: Flag.String('origin'),
    run: Flag.Boolean('run'),
  },
  () =>
    Effect.gen(function* execute() {
      // Keep the proof's exact opt-in invocation even when the general CLI parser accepts reordered flags.
      const stdio = yield* Stdio.Stdio;
      const args = yield* parseSymmyNegativeProofArguments(yield* stdio.args);
      const config = yield* loadSymmyNegativeProofConfig(args);
      return yield* runSymmyNegativeProof(config, { writeLine: (line) => Console.log(line) });
    }),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run(command, { renderErrors: false, version: '1.0.0' }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.tapCause((cause) =>
        Console.error(
          Option.match(Cause.findErrorOption(cause), {
            onNone: () => 'FAIL configuration status=none reason=unexpected_failure',
            onSome: (error) =>
              CliError.isCliError(error)
                ? 'FAIL configuration status=none reason=invalid_arguments'
                : symmyNegativeProofFailureLine(error),
          }),
        ),
      ),
    ),
    { disableErrorReporting: true },
  );
}
