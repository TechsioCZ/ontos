import { sha256 } from '@noble/hashes/sha2.js';
import { uploadAssetAction } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import { principalOf } from './core-media-e2e-fixture.ts';
import type { E2eActor, MediaE2eWorld, ShellEdge } from './core-media-e2e-fixture.ts';

/*
 * The steps every Core Media end-to-end scenario is made of. A step is one real request: a governed Action run, or an
 * HTTP request to the production Shell on loopback. Nothing here decides an outcome; the answers are the system's.
 */

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

export const metadataOf = (edge: ShellEdge, actor: E2eActor, mediaAssetId: string) =>
  edge
    .request({
      actor,
      body: JSON.stringify({
        mediaAssetRef: {
          moduleId: 'core.media',
          resourceId: mediaAssetId,
          resourceType: 'core.media.asset',
          tenantId: actor.tenantId,
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
export const requireFaultInjection = (ctx: { readonly skip: () => void }, world: MediaE2eWorld) =>
  Option.match(world.faultInjection, {
    onNone: () => Effect.sync(() => ctx.skip()).pipe(Effect.andThen(Effect.never)),
    onSome: Effect.succeed,
  });
