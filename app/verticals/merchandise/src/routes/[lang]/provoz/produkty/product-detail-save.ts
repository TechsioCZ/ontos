// Draft and save of the product detail form: what one save sends, and which revision it expects.
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
import type { DetailDraft } from './product-detail-draft.ts';
import { mergeDraft } from './product-draft-merge.ts';
import { refusedSave, useDraftRebase } from './product-draft-rebase.ts';
import type { Refusal } from './product-draft-rebase.ts';

type CommandFailure = Effect.Error<ReturnType<typeof runProductCommand>>;

const idempotencyKey = Effect.all({ now: DateTime.now, random: Random.nextInt }, { concurrency: 1 }).pipe(
  Effect.map(({ now, random }) => `merchandise:product:${DateTime.toEpochMillis(now)}:${random}`),
);

/** One merchandise command; the revision the server answered with is the one the next command must expect. */
const runProductCommand = (
  command: Extract<MerchandiseCommand, { readonly _tag: 'UpdateProduct' | 'ChangePrice' }>,
  expectedRevision: number,
) =>
  idempotencyKey.pipe(
    Effect.flatMap((key) => executeManageCatalog({ command, expectedRevision }, key, { idempotencyKey: key })),
    Effect.flatMap(committedResult),
    Effect.map((result) => result.revision),
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
  readonly expectedRevision: number;
  readonly productId: ProductRecord['id'];
  readonly value: DetailDraft;
}

/**
 * One save of the detail form: the changed basic fields first, then a changed price. The first command expects
 * the revision the draft is based on, the second the one the first left. A conflict keeps the draft and offers the
 * version someone else saved.
 *
 * When the fields went through and the price did not, the server has the draft's fields with the confirmed price.
 * The save reports that version and its revision (`PartlySaved`): the next save then sends the price alone, and a
 * field typed back to its earlier value is sent as the change it now is, instead of comparing equal to a version the
 * server no longer has.
 */
const saveDetailEffect = ({
  confirmed,
  expectedRevision,
  productId,
  value,
}: DetailSaveInput): Effect.Effect<DraftSaveEnd<DetailDraft>> => {
  const { patch, priceChanged, priceMinor } = detailSaveOf(value, confirmed);
  const fieldsChanged = Object.keys(patch).length !== 0;
  if (!fieldsChanged && !priceChanged) {
    return Effect.succeed('saved');
  }
  const update: Effect.Effect<number, CommandFailure> = fieldsChanged
    ? runProductCommand({ _tag: 'UpdateProduct', id: productId, patch }, expectedRevision)
    : Effect.succeed(expectedRevision);
  return update.pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.succeed<DraftSaveEnd<DetailDraft>>(failureOutcome(error)),
      onSuccess: (revision) =>
        priceChanged
          ? runProductCommand({ _tag: 'ChangePrice', id: productId, priceMinor }, revision).pipe(
              Effect.match({
                onFailure: (error): DraftSaveEnd<DetailDraft> => {
                  const outcome = failureOutcome(error);
                  return fieldsChanged
                    ? {
                        confirmed: { ...value, priceCzk: confirmed.priceCzk, priceText: confirmed.priceText },
                        outcome,
                        revision,
                      }
                    : outcome;
                },
                onSuccess: (next): DraftSaveEnd<DetailDraft> => next,
              }),
            )
          : Effect.succeed<DraftSaveEnd<DetailDraft>>(revision),
    }),
  );
};

/** A save someone else's change refused: the version it was based on and the revision it expected. */
const refusalOf = (
  result: DraftSaveEnd<DetailDraft>,
  confirmed: DetailDraft,
  expectedRevision: number,
): Refusal<DetailDraft> | undefined => {
  if (result === 'conflict') {
    return refusedSave(confirmed, expectedRevision);
  }
  // The fields went through and left `revision`; the price, sent against it, was refused.
  if (typeof result === 'object' && result.outcome === 'conflict') {
    return refusedSave(result.confirmed, result.revision);
  }
  return undefined;
};

/** The revision a chain of this page's own stock commands left behind, starting from the one they replaced. */
const afterStockCommits = (commits: ReadonlyMap<number, number>, revision: number): number => {
  const next = commits.get(revision);
  return next === undefined ? revision : afterStockCommits(commits, next);
};

interface ProductDetailDraftOptions {
  /** Re-reads the product: after a save someone else's change refused, and on "Načíst aktuální verzi". */
  readonly onReload: () => void;
  readonly product: ProductRecord;
  /** The catalog revision `product` was read at. */
  readonly revision: number;
}

/**
 * Draft and save of the product detail form. Nothing is sent until `record.save()`, the form's Save button. The
 * editor stays mounted while its product reloads: an untouched draft takes the reloaded product, a changed one stays
 * and keeps expecting the revision it was based on (`useRecordDraft`), so a change someone else made in the meantime
 * ends in a conflict instead of being overwritten. A refused save re-reads the product and puts the draft's own changes
 * over the version someone else saved (`useDraftRebase`): saved again at once when they overlap nothing that version
 * changed, otherwise kept behind the conflict message until "Načíst aktuální verzi".
 *
 * `product` still shows the version before the form's own save until its reload lands, so a save sends what differs
 * from the version the server last confirmed, not from `product`.
 */
export const useProductDetailDraft = ({ onReload, product, revision }: ProductDetailDraftOptions) => {
  // Real variants are read-only on the detail tab and always come from the latest product.
  // Deriving them preserves unsaved detail fields when the variants tab commits a change.
  const realVariants = (product.variants ?? []).filter(isRealVariant);
  const stockCommits = useRef(new Map<number, number>());
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
  const record = useRecordDraft<DetailDraft, never>({
    equals: sameDetailDraft,
    isValid: (value) => !detailDraftInvalid(value),
    kept,
    revision,
    runtime: browserRuntime,
    save: (value, expectedRevision, confirmed) => {
      const expected = afterStockCommits(stockCommits.current, expectedRevision);
      return saveDetailEffect({
        confirmed: { ...confirmed, realVariants },
        expectedRevision: expected,
        productId: product.id,
        value: { ...value, realVariants },
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const refused = refusalOf(result, confirmed, expected);
            if (refused !== undefined) {
              // Read the version someone else saved; the draft's own changes then go over it.
              refusal.current = refused;
              onReload();
            }
          }),
        ),
      );
    },
    server,
  });
  const { kept: keptNow } = record;
  useEffect(() => keepDraftOnReload(keepKey, keptNow), [keepKey, keptNow]);
  const reloadLatest = useDraftRebase({
    current: () => ({ base: record.confirmed, from: record.kept()?.revision ?? revision }),
    // Real variants are not this form's: they always come from the latest product.
    merge: (base, mine, theirs) => mergeDraft({ ...base, realVariants }, { ...mine, realVariants }, theirs),
    onReload,
    refusal,
    revision,
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
  /**
   * A stock movement of this page went through: it replaced `expectedRevision` with `next` and changed no field of
   * this form. A draft based on exactly the replaced revision is therefore based on `next` too, and its save does
   * not have to wait for the reloaded product to avoid a conflict with the page's own movement. A draft based on an
   * older revision is not moved. Commands that write fields this form also sends (variants, e-shop content) must not
   * be reported here: until the reload lands the form would send its old copy over them.
   */
  const followStockCommit = (expectedRevision: number, next: number) => {
    if (next > expectedRevision) {
      stockCommits.current.set(expectedRevision, next);
    }
  };
  return { draft: { ...record.draft, realVariants }, followStockCommit, record, reloadLatest };
};
