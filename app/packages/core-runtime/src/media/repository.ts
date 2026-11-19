import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';

import { mediaAssets } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { mediaAssetNotFound, mediaUnavailable } from './errors.ts';
import type { MediaUnavailable } from './errors.ts';
import type { MediaAssetId } from './identity.ts';
import { deriveMediaStorageKey } from './storage-key.ts';
import type { MediaStorageKey } from './storage-key.ts';
import { mediaStatusesThatMayEnter } from './public-contract.ts';
import type {
  MediaByteSize,
  MediaContentSha256,
  MediaIngestionSource,
  MediaProcessingStatus,
} from './public-contract.ts';

/** The persisted row, storage columns included. Owner-local: it never leaves Core, only its projection does. */
export type MediaAssetRecord = typeof mediaAssets.$inferSelect;

/** The reservation of an asset: the row that anchors one intended upload before any byte is stored. */
export interface ReserveMediaAssetInput {
  /** The declared size; the confirmed size replaces it when the asset becomes `ready`. */
  readonly byteSize: MediaByteSize;
  readonly displayFilename: string;
  readonly externalSourceRef?: string;
  readonly ingestedByPrincipalId?: string;
  readonly ingestionSource: MediaIngestionSource;
  /** Chosen by the owner so the storage key can derive from it before the insert. */
  readonly mediaAssetId: MediaAssetId;
  readonly mimeType: string;
  readonly originalFilename?: string;
  readonly storageProvider: string;
}

/** What the confirmed, verified bytes look like. Only a transition to `ready` carries it. */
export interface ConfirmedMediaBytes {
  readonly byteSize: MediaByteSize;
  readonly contentSha256: MediaContentSha256;
  /** The provider's technical version pin, when it returned one. Never a revision. */
  readonly storageObjectVersionRef?: string;
}

export type MediaAssetTransition =
  | { readonly confirmed: ConfirmedMediaBytes; readonly to: 'ready' }
  | { readonly to: 'failed' | 'scanning' };

export type MediaTransitionOutcome =
  /** The row was in an allowed source status and now has the new one. */
  | { readonly asset: MediaAssetRecord; readonly kind: 'applied' }
  /** The row exists but its status does not allow the move; `current` is what stayed untouched. */
  | { readonly current: MediaAssetRecord; readonly kind: 'rejected' };

const persistenceUnavailable = (cause: unknown): MediaUnavailable =>
  mediaUnavailable('Media asset persistence is temporarily unavailable', cause);

/**
 * The Media repository for one Core-owned scoped transaction; its members are the only operations a handler can
 * perform. It is built from the trusted transaction, takes
 * the tenant and company from that scope (never from a caller) and exposes no raw executor, so a handler can
 * only do what this interface names.
 */
export const makeMediaAssetRepository = (transaction: ScopedTransactionExecutor) => {
  const { legalEntityId, tenantId } = transaction.scope;
  /** An unselected company means tenant-wide; a selected one sees its own and company-less assets only. */
  const scopePredicate = (mediaAssetId: MediaAssetId) =>
    and(
      eq(mediaAssets.tenantId, tenantId),
      eq(mediaAssets.mediaAssetId, mediaAssetId),
      legalEntityId === undefined
        ? undefined
        : or(isNull(mediaAssets.legalEntityId), eq(mediaAssets.legalEntityId, legalEntityId)),
    );

  const find = Effect.fn('MediaAssetRepository.find')(function* find(mediaAssetId: MediaAssetId) {
    const [row, extra] = yield* transaction
      .select()
      .from(mediaAssets)
      .where(scopePredicate(mediaAssetId))
      .limit(2)
      .pipe(Effect.mapError(persistenceUnavailable));
    if (row === undefined) {
      return yield* mediaAssetNotFound();
    }
    if (extra !== undefined) {
      return yield* mediaUnavailable('Media asset identity is ambiguous');
    }
    return row;
  });

  return {
    find,
    findByStorageIdentity: Effect.fn('MediaAssetRepository.findByStorageIdentity')(function* findByStorageIdentity({
      storageKey,
      storageProvider,
    }: {
      readonly storageKey: MediaStorageKey;
      readonly storageProvider: string;
    }) {
      const [row, extra] = yield* transaction
        .select()
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.tenantId, tenantId),
            eq(mediaAssets.storageProvider, storageProvider),
            eq(mediaAssets.storageKey, storageKey),
          ),
        )
        .limit(2)
        .pipe(Effect.mapError(persistenceUnavailable));
      if (extra !== undefined) {
        return yield* mediaUnavailable('Media storage identity is ambiguous');
      }
      return Option.fromUndefinedOr(row);
    }),
    renameDisplayFilename: Effect.fn('MediaAssetRepository.renameDisplayFilename')(function* rename(
      mediaAssetId: MediaAssetId,
      displayFilename: string,
    ) {
      const now = yield* DateTime.nowAsDate;
      const [row] = yield* transaction
        .update(mediaAssets)
        .set({ displayFilename, updatedAt: now })
        .where(scopePredicate(mediaAssetId))
        .returning()
        .pipe(Effect.mapError(persistenceUnavailable));
      return row ?? (yield* mediaAssetNotFound());
    }),
    reserve: Effect.fn('MediaAssetRepository.reserve')(function* reserve(input: ReserveMediaAssetInput) {
      const [row] = yield* transaction
        .insert(mediaAssets)
        .values({
          byteSize: BigInt(input.byteSize),
          displayFilename: input.displayFilename,
          externalSourceRef: input.externalSourceRef ?? null,
          ingestedByPrincipalId: input.ingestedByPrincipalId ?? null,
          ingestionSource: input.ingestionSource,
          legalEntityId: legalEntityId ?? null,
          mediaAssetId: input.mediaAssetId,
          mimeType: input.mimeType,
          originalFilename: input.originalFilename ?? null,
          processingStatus: 'uploaded' satisfies MediaProcessingStatus,
          storageKey: deriveMediaStorageKey({ mediaAssetId: input.mediaAssetId, tenantId }),
          storageProvider: input.storageProvider,
          tenantId,
        })
        .returning()
        .pipe(Effect.mapError(persistenceUnavailable));
      return row ?? (yield* mediaUnavailable('Media asset was not reserved'));
    }),
    transition: Effect.fn('MediaAssetRepository.transition')(function* applyTransition(
      mediaAssetId: MediaAssetId,
      transition: MediaAssetTransition,
    ) {
      const now = yield* DateTime.nowAsDate;
      const changes =
        transition.to === 'ready'
          ? {
              byteSize: BigInt(transition.confirmed.byteSize),
              contentSha256: transition.confirmed.contentSha256,
              processingStatus: transition.to,
              sealedAt: now,
              storageObjectVersionRef: transition.confirmed.storageObjectVersionRef ?? null,
              updatedAt: now,
            }
          : { processingStatus: transition.to, updatedAt: now };
      const [row] = yield* transaction
        .update(mediaAssets)
        .set(changes)
        .where(
          and(
            scopePredicate(mediaAssetId),
            inArray(mediaAssets.processingStatus, [...mediaStatusesThatMayEnter(transition.to)]),
          ),
        )
        .returning()
        .pipe(Effect.mapError(persistenceUnavailable));
      if (row !== undefined) {
        return { asset: row, kind: 'applied' } as const;
      }
      // Nothing matched: the asset is missing (not found) or its status forbids the move (rejected, untouched).
      return { current: yield* find(mediaAssetId), kind: 'rejected' } as const;
    }),
  };
};
