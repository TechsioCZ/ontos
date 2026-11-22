import { sha256 } from '@noble/hashes/sha2.js';
import { assetCurrentRead, renameDisplayFilenameAction, uploadAssetAction } from '@app/core-runtime';
import { Cause, Effect, Exit, Option, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { principalOf, skipScenario } from './core-media-e2e-fixture.ts';
import type { E2eActor, MediaE2eWorld, ShellEdge } from './core-media-e2e-fixture.ts';

/*
 * The steps every Core Media end-to-end scenario is made of. A step is one real request: a governed Action run, or an
 * HTTP request to the production Shell on loopback. Nothing here decides an outcome; the answers are the system's.
 */

const CORE_MEDIA_MODULE = 'core.media';
const CORE_MEDIA_RESOURCE_TYPE = 'core.media.asset';

export const digestOf = (bytes: Uint8Array): string => Hex.encode(sha256(bytes));
export const bytesOf = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
export const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** A deterministic body of the given length, so a transfer spans many chunks without a random source. */
export const patternBytes = (length: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + 7) % 251;
  }
  return bytes;
};

export interface ReservationOptions {
  readonly displayFilename?: string;
  readonly idempotencyKey: string;
  readonly mimeType?: string;
  readonly originalFilename?: string;
}

const JsonText = Schema.fromJsonString(Schema.Json);
export const parseJson = (bytes: Uint8Array): typeof Schema.Json.Type =>
  Schema.decodeUnknownSync(JsonText)(textOf(bytes));

/** The reservation Action, run as the actor through the governed runtime over the real gate. */
export const reservationPayload = (bytes: Uint8Array, options: Omit<ReservationOptions, 'idempotencyKey'> = {}) => {
  const payload = {
    declaredByteSize: bytes.byteLength,
    declaredContentSha256: digestOf(bytes),
    displayFilename: options.displayFilename ?? 'Brochure.pdf',
    ingestionSource: 'user' as const,
    mimeType: options.mimeType ?? 'application/pdf',
  };
  return options.originalFilename === undefined ? payload : { ...payload, originalFilename: options.originalFilename };
};

export const reserve = Effect.fn('CoreMediaE2e.reserve')(function* reserve(
  world: MediaE2eWorld,
  actor: E2eActor,
  bytes: Uint8Array,
  options: ReservationOptions,
) {
  const principal = yield* principalOf(actor);
  return yield* world.withStorage(
    world.actions.runAction({
      payload: reservationPayload(bytes, options),
      principal,
      registration: uploadAssetAction,
      transport: { correlationId: `e2e-reserve-${options.idempotencyKey}`, idempotencyKey: options.idempotencyKey },
    }),
  );
});

export const putBytes = (edge: ShellEdge, actor: E2eActor, mediaAssetId: string, bytes: Uint8Array<ArrayBuffer>) =>
  edge.request({
    actor,
    body: bytes,
    headers: { 'content-type': 'application/octet-stream', 'x-correlation-id': `e2e-put-${mediaAssetId}` },
    method: 'PUT',
    path: `/core/media/assets/${mediaAssetId}/bytes`,
  });

export const downloadOf = (edge: ShellEdge, actor: E2eActor, mediaAssetId: string) =>
  edge.request({
    actor,
    headers: { 'x-correlation-id': `e2e-get-${mediaAssetId}` },
    method: 'GET',
    path: `/core/media/assets/${mediaAssetId}/content`,
  });

export const metadataOf = (edge: ShellEdge, actor: E2eActor, mediaAssetId: string, tenantId = actor.tenantId) =>
  edge
    .request({
      actor,
      body: JSON.stringify({
        mediaAssetRef: {
          moduleId: CORE_MEDIA_MODULE,
          resourceId: mediaAssetId,
          resourceType: CORE_MEDIA_RESOURCE_TYPE,
          tenantId,
        },
      }),
      headers: { 'content-type': 'application/json', 'x-correlation-id': `e2e-meta-${mediaAssetId}` },
      method: 'POST',
      path: '/core/reads/asset-metadata',
    })
    .pipe(
      Effect.map((response) => ({
        ...response,
        json: response.headers.get('content-type')?.includes('json') === true ? parseJson(response.bytes) : null,
      })),
    );

export interface AssetRow {
  readonly byte_size: string | null;
  readonly content_sha256: string | null;
  readonly media_asset_id: string;
  readonly processing_status: string;
  readonly sealed_at: Date | null;
  readonly storage_key: string;
}

/** The recorded row, read by the harness's own privileged connection: an observation, never a request. */
export const rowsOf = (world: MediaE2eWorld) =>
  world.admin
    .unsafe<AssetRow>(
      `select media_asset_id, processing_status, byte_size::text as byte_size, content_sha256, sealed_at, storage_key
         from core.media_assets where tenant_id = $1 order by created_at, media_asset_id`,
      [world.tenantId],
    )
    .pipe(Effect.orDie);

export const rowOf = (world: MediaE2eWorld, mediaAssetId: string) =>
  rowsOf(world).pipe(Effect.map((rows) => rows.find((row) => row.media_asset_id === mediaAssetId)));

/** The fault relays, or the scenario is skipped: without them the run cannot say what a fault does. */
export const requireFaultInjection = (ctx: { readonly skip: (note?: string) => void }, world: MediaE2eWorld) =>
  Option.match(world.faultInjection, {
    onNone: () =>
      skipScenario(ctx, 'BLOCKED: the run names no fault relays (D20_E2E_S3_UPSTREAM, D20_E2E_ENGINE_UPSTREAM)'),
    onSome: Effect.succeed,
  });

const ObservedFailure = Schema.Struct({
  _tag: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
});
const observedFailure = (failure: Option.Option<unknown>) =>
  failure.pipe(Option.flatMap((value) => Schema.decodeUnknownOption(ObservedFailure)(value)));

/** The tag of the typed failure an effect ended with, `none` when it succeeded, `defect` for anything untyped. */
export const failureTagOf = <Value, Failure>(effect: Effect.Effect<Value, Failure>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? 'none'
        : Option.getOrElse(
            Option.flatMap(observedFailure(Cause.findErrorOption(exit.cause)), ({ _tag }) =>
              Option.fromNullishOr(_tag),
            ),
            () => 'defect',
          ),
    ),
  );

/** The stable code of the typed failure an effect ended with, `none` when it succeeded. */
export const failureCodeOf = <Value, Failure>(effect: Effect.Effect<Value, Failure>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? 'none'
        : Option.getOrElse(
            Option.flatMap(observedFailure(Cause.findErrorOption(exit.cause)), ({ code }) =>
              Option.fromNullishOr(code),
            ),
            () => 'defect',
          ),
    ),
  );

/** The rename Action, run as the actor through the governed runtime over the real gate. */
export const renameAs = (
  world: MediaE2eWorld,
  actor: E2eActor,
  mediaAssetRef: { readonly resourceId: string },
  displayFilename: string,
  idempotencyKey: string,
) =>
  Effect.gen(function* renameStep() {
    const principal = yield* principalOf(actor);
    return yield* world.withStorage(
      world.actions.runAction({
        payload: {
          displayFilename,
          mediaAssetRef: {
            moduleId: CORE_MEDIA_MODULE,
            resourceId: mediaAssetRef.resourceId,
            resourceType: CORE_MEDIA_RESOURCE_TYPE,
            tenantId: actor.tenantId,
          },
        },
        principal,
        registration: renameDisplayFilenameAction,
        transport: { correlationId: `e2e-rename-${idempotencyKey}`, idempotencyKey },
      }),
    );
  });

/** A value the scenario needs, or a defect that names what the world lacked. */
export const needed = <Value>(value: Value | undefined, what: string): Effect.Effect<Value> =>
  value === undefined ? Effect.die(`The world has no ${what}`) : Effect.succeed(value);

/** Repeats a request until its answer is the wanted one, pausing in the database so no timer is involved. */
export const untilStatus = Effect.fn('CoreMediaE2e.untilStatus')(function* untilStatus<
  Response extends { readonly status: number },
>(world: MediaE2eWorld, attempt: Effect.Effect<Response>, status: number, attempts = 40) {
  let answer = yield* attempt;
  for (let remaining = attempts; remaining > 0 && answer.status !== status; remaining -= 1) {
    yield* world.admin.unsafe('select pg_sleep(0.5)').pipe(Effect.orDie);
    answer = yield* attempt;
  }
  return answer;
});

export const refOf = (tenantId: string, mediaAssetId: string) =>
  ({
    moduleId: CORE_MEDIA_MODULE,
    resourceId: mediaAssetId,
    resourceType: CORE_MEDIA_RESOURCE_TYPE,
    tenantId,
  }) as const;

/** The Core owner Current V1 read for the exact refs, run as the actor through the governed Read runtime. */
export const currentOf = (world: MediaE2eWorld, actor: E2eActor, refs: readonly ReturnType<typeof refOf>[]) =>
  Effect.gen(function* currentStep() {
    const principal = yield* principalOf(actor);
    const [first, ...rest] = refs;
    return yield* world.withStorage(
      world.reads.runRead({
        input: { mediaAssetRefs: first === undefined ? [] : [first, ...rest] },
        principal,
        registration: assetCurrentRead,
        transport: { correlationId: `e2e-current-${actor.name}` },
      }),
    );
  });

// ---------------------------------------------------------------------------------------------
// The Core Action routes: `POST /core/actions/<action>` with the Shell's Idempotency-Key header
// ---------------------------------------------------------------------------------------------

/** One Core Action request to the production Shell, answered as its status and parsed JSON body. A null key sends none. */
const coreActionOf = (
  edge: ShellEdge,
  actor: E2eActor,
  action: string,
  payload: typeof Schema.Json.Type,
  idempotencyKey: string | null,
) => {
  const base = {
    'content-type': 'application/json',
    'x-correlation-id': `e2e-${action}-${idempotencyKey ?? 'keyless'}`,
  };
  const headers = idempotencyKey === null ? base : { ...base, 'idempotency-key': idempotencyKey };
  return edge
    .request({ actor, body: JSON.stringify(payload), headers, method: 'POST', path: `/core/actions/${action}` })
    .pipe(
      Effect.map((response) => ({
        ...response,
        json: response.headers.get('content-type')?.includes('json') === true ? parseJson(response.bytes) : null,
      })),
    );
};

/** The reservation over HTTP: the answer carries the media asset reference, whose id the bytes are then sent to. */
export const reserveOverHttp = (
  edge: ShellEdge,
  actor: E2eActor,
  bytes: Uint8Array,
  options: Omit<ReservationOptions, 'idempotencyKey'> & { readonly idempotencyKey: string | null },
) => coreActionOf(edge, actor, 'upload-asset', reservationPayload(bytes, options), options.idempotencyKey);

/** The confirmation over HTTP: the host settles the stored object, the Action decides under the caller's capability. */
export const confirmOverHttp = (
  edge: ShellEdge,
  actor: E2eActor,
  mediaAssetId: string,
  idempotencyKey: string | null,
) => coreActionOf(edge, actor, 'confirm-asset', { mediaAssetRef: refOf(actor.tenantId, mediaAssetId) }, idempotencyKey);

export const renameOverHttp = (
  edge: ShellEdge,
  actor: E2eActor,
  mediaAssetId: string,
  displayFilename: string,
  idempotencyKey: string | null,
) =>
  coreActionOf(
    edge,
    actor,
    'rename-display-filename',
    { displayFilename, mediaAssetRef: refOf(actor.tenantId, mediaAssetId) },
    idempotencyKey,
  );
