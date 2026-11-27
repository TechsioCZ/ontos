// Draft and save of the product detail form: what one save sends, and which product version it names.
import { useRecordDraft } from '@app/admin-ui';
import type { DraftSaveEnd, DraftSaveOutcome, KeptDraft } from '@app/admin-ui';
import { keepDraftOnReload, keptDraft, releaseGone } from '@app/shared-contracts';
import { DateTime, Effect, Predicate, Random } from 'effect';
import { useEffect, useRef, useState } from 'react';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { isRealVariant } from '../../../../../shared/domain/merchandise-model.ts';
import { committedResult, pendingProposalMessage } from '../../../../api/action-result.ts';
import { executeManageCatalog } from '../../../../api/manage-catalog-action-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { detailDraftInvalid, detailSaveOf, draftOf, sameDetailDraft } from './product-detail-draft.ts';
import { productVersionOf } from './products-api.ts';
import type { DetailDraft } from './product-detail-draft.ts';
import { mergeDraft } from './product-draft-merge.ts';
import { refusedSave, useDraftRebase } from './product-draft-rebase.ts';
import type { Refusal } from './product-draft-rebase.ts';
import { writeThroughSymmyVariant } from './symmy-write-through.ts';

type CommandFailure = Effect.Error<ReturnType<typeof runProductCommand>>;

const idempotencyKey = Effect.all({ now: DateTime.now, random: Random.nextInt }, { concurrency: 1 }).pipe(
  Effect.map(({ now, random }) => `merchandise:product:${DateTime.toEpochMillis(now)}:${random}`),
);

/**
 * One merchandise command naming the product version `expectedVersion` (`productVersionOf`): the server refuses it
 * only when this product changed since. It answers with the product's version after it, which the next command names.
 * `revision` is the catalogue revision the page read, which the server does not check for such a command.
 */
const runProductCommand = (
  command: Extract<MerchandiseCommand, { readonly _tag: 'UpdateProduct' | 'ChangePrice' }>,
  expectedVersion: number,
  revision: number,
) =>
  idempotencyKey.pipe(
    Effect.flatMap((key) =>
      executeManageCatalog(
        {
          command: { ...command, expectedUpdatedAt: DateTime.makeUnsafe(expectedVersion) },
          expectedRevision: revision,
        },
        key,
        { idempotencyKey: key },
      ),
    ),
    Effect.flatMap(committedResult),
    Effect.map((result) =>
      result.updatedAt === undefined ? expectedVersion : DateTime.toEpochMillis(result.updatedAt),
    ),
  );

/**
 * Why a command wrote nothing: parked for approval (the draft is then held and never sent again), refused because
 * someone else changed the catalog, refused because a deploy left this tab behind, or failed.
 */
const failureOutcome = (error: CommandFailure): Exclude<DraftSaveOutcome, 'saved'> => {
  if (pendingProposalMessage(error) !== undefined) {
    return 'proposed';
  }
  if (releaseGone(error)) {
    return 'reload-required';
  }
  return Predicate.isTagged(error, 'ManageCatalogActionConflictProblem') &&
    error.code !== 'merchandise_lifecycle_conflict'
    ? 'conflict'
    : 'failed';
};

interface DetailSaveInput {
  /** The version the server last confirmed for this draft; the save sends what differs from it. */
  readonly confirmed: DetailDraft;
  /** The product version the draft is based on. */
  readonly expectedVersion: number;
  readonly productId: ProductRecord['id'];
  /** The catalogue revision the page read. */
  readonly revision: number;
  /**
   * A product imported through Symmy: a changed price is written to Pricing first, so Symmy reads it back; when that
   * fails, nothing is saved and the failure is the save's outcome.
   */
  readonly symmy: { readonly catalogProductId: string; readonly catalogVariantId: string } | undefined;
  readonly onWriteThroughFailed: (message: string | null) => void;
  readonly value: DetailDraft;
}

/**
 * One save of the detail form: the changed basic fields first, then a changed price. The first command names the
 * product version the draft is based on, the second the one the first left. A conflict keeps the draft and offers the
 * version someone else saved.
 *
 * When the fields went through and the price did not, the server has the draft's fields with the confirmed price.
 * The save reports that version and the product version it left (`PartlySaved`): the next save then sends the price
 * alone, and a field typed back to its earlier value is sent as the change it now is, instead of comparing equal to a
 * version the server no longer has.
 */
const saveDetailEffect = ({
  confirmed,
  expectedVersion,
  onWriteThroughFailed,
  productId,
  revision,
  symmy,
  value,
}: DetailSaveInput): Effect.Effect<DraftSaveEnd<DetailDraft>> => {
  const { patch, priceChanged, priceMinor } = detailSaveOf(value, confirmed);
  const fieldsChanged = Object.keys(patch).length !== 0;
  if (!fieldsChanged && !priceChanged) {
    return Effect.succeed('saved');
  }
  if (priceChanged && symmy !== undefined) {
    return writeThroughSymmyVariant({
      catalogProductId: symmy.catalogProductId,
      catalogVariantId: symmy.catalogVariantId,
      priceNet: (priceMinor / 100).toFixed(2),
      reason: 'Úprava v Produkty',
    }).pipe(
      Effect.matchEffect({
        onFailure: (message) =>
          Effect.sync((): DraftSaveEnd<DetailDraft> => {
            onWriteThroughFailed(message);
            return 'failed';
          }),
        onSuccess: () =>
          Effect.sync(() => onWriteThroughFailed(null)).pipe(
            Effect.andThen(saveDetailEffect({ confirmed, expectedVersion, onWriteThroughFailed, productId, revision, symmy: undefined, value })),
          ),
      }),
    );
  }
  const update: Effect.Effect<number, CommandFailure> = fieldsChanged
    ? runProductCommand({ _tag: 'UpdateProduct', id: productId, patch }, expectedVersion, revision)
    : Effect.succeed(expectedVersion);
  return update.pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.succeed<DraftSaveEnd<DetailDraft>>(failureOutcome(error)),
      onSuccess: (version) =>
        priceChanged
          ? runProductCommand({ _tag: 'ChangePrice', id: productId, priceMinor }, version, revision).pipe(
              Effect.match({
                onFailure: (error): DraftSaveEnd<DetailDraft> => {
                  const outcome = failureOutcome(error);
                  return fieldsChanged
                    ? {
                        confirmed: { ...value, priceCzk: confirmed.priceCzk, priceText: confirmed.priceText },
                        outcome,
                        revision: version,
                      }
                    : outcome;
                },
                onSuccess: (next): DraftSaveEnd<DetailDraft> => next,
              }),
            )
          : Effect.succeed<DraftSaveEnd<DetailDraft>>(version),
    }),
  );
};

/** A save someone else's change refused: the draft version it was based on and the product version it named. */
const refusalOf = (
  result: DraftSaveEnd<DetailDraft>,
  confirmed: DetailDraft,
  expectedVersion: number,
): Refusal<DetailDraft> | undefined => {
  if (result === 'conflict') {
    return refusedSave(confirmed, expectedVersion);
  }
  // The fields went through and left product version `revision`; the price, naming it, was refused.
  if (typeof result === 'object' && result.outcome === 'conflict') {
    return refusedSave(result.confirmed, result.revision);
  }
  return undefined;
};

interface ProductDetailDraftOptions {
  /** Re-reads the product: after a save someone else's change refused, and on "Načíst aktuální verzi". */
  readonly onReload: () => void;
  readonly product: ProductRecord;
  /** The catalogue revision `product` was read at, sent along with each command. */
  readonly revision: number;
}

/**
 * Draft and save of the product detail form. Nothing is sent until `record.save()`, the form's Save button. The
 * editor stays mounted while its product reloads: an untouched draft takes the reloaded product, a changed one stays
 * and keeps naming the product version it was based on (`useRecordDraft` over `productVersionOf`), so a change
 * someone else made to this product in the meantime ends in a conflict instead of being overwritten; a stock movement,
 * an order or an edit of another product leaves the version, and so the save, alone. A refused save re-reads the
 * product and puts the draft's own changes over the version someone else saved (`useDraftRebase`): saved again at
 * once when they overlap nothing that version changed, otherwise kept behind the conflict message until "Načíst
 * aktuální verzi".
 *
 * `product` still shows the version before the form's own save until its reload lands, so a save sends what differs
 * from the version the server last confirmed, not from `product`.
 */
export const useProductDetailDraft = ({ onReload, product, revision }: ProductDetailDraftOptions) => {
  // Real variants are read-only on the detail tab and always come from the latest product.
  // Deriving them preserves unsaved detail fields when the variants tab commits a change.
  const realVariants = (product.variants ?? []).filter(isRealVariant);
  const version = productVersionOf(product);
  const server = draftOf(product);
  // A reload that kept this form's draft: it comes back unsaved over this release's draft shape.
  const keepKey = `merchandise:product-detail:${product.id}`;
  const [kept] = useState(() => {
    const draft = keptDraft<KeptDraft<DetailDraft>>(keepKey);
    return draft === undefined
      ? undefined
      : {
          confirmed: { ...server, ...draft.confirmed, realVariants },
          revision: draft.revision,
          value: { ...server, ...draft.value, realVariants },
        };
  });
  // A save someone else's change refused, until the draft is rebased on the version they saved.
  const refusal = useRef<Refusal<DetailDraft> | undefined>(undefined);
  // Why the last save of a Symmy product's price wrote nothing: Pricing refused the write-through.
  const [writeThroughError, setWriteThroughError] = useState<string | null>(null);
  const symmy =
    product.importedVia === 'symmy' && product.catalogProductId !== undefined && product.catalogVariantId !== undefined
      ? { catalogProductId: product.catalogProductId, catalogVariantId: product.catalogVariantId }
      : undefined;
  const record = useRecordDraft<DetailDraft, never>({
    equals: sameDetailDraft,
    isValid: (value) => !detailDraftInvalid(value),
    kept,
    revision: version,
    runtime: browserRuntime,
    save: (value, expectedVersion, confirmed) =>
      saveDetailEffect({
        confirmed: { ...confirmed, realVariants },
        expectedVersion,
        onWriteThroughFailed: setWriteThroughError,
        productId: product.id,
        revision,
        symmy,
        value: { ...value, realVariants },
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const refused = refusalOf(result, confirmed, expectedVersion);
            if (refused !== undefined) {
              // Read the version someone else saved; the draft's own changes then go over it.
              refusal.current = refused;
              onReload();
            }
          }),
        ),
      ),
    server,
  });
  const { kept: keptNow } = record;
  useEffect(() => keepDraftOnReload(keepKey, keptNow), [keepKey, keptNow]);
  const reloadLatest = useDraftRebase({
    current: () => ({ base: record.confirmed, from: record.kept()?.revision ?? version }),
    // Real variants are not this form's: they always come from the latest product.
    merge: (base, mine, theirs) => mergeDraft({ ...base, realVariants }, { ...mine, realVariants }, theirs),
    onReload,
    refusal,
    revision: version,
    save: record.save,
    server,
    stale: false,
    status: record.status,
    take: (fresh, merged) => {
      record.adopt(fresh);
      record.setDraft(merged);
    },
    value: record.draft,
  });
  return { draft: { ...record.draft, realVariants }, record, reloadLatest, writeThroughError };
};
