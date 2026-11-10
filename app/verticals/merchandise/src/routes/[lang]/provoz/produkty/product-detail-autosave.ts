// Draft and autosave of the product detail form: what one save sends, and which revision it expects.
import { useAutosaveDraft } from '@app/admin-ui';
import type { DraftSaveResult } from '@app/admin-ui';
import { DateTime, Effect, Predicate, Random } from 'effect';
import { useRef, useState } from 'react';
import type { MerchandiseCommand } from '../../../../../shared/actions/apply-command.ts';
import type { ProductRecord } from '../../../../../shared/apis/records.ts';
import { isRealVariant } from '../../../../../shared/domain/merchandise-model.ts';
import { committedResult, pendingProposalMessage } from '../../../../api/action-result.ts';
import { executeManageCatalog } from '../../../../api/manage-catalog-action-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { detailDraftInvalid, detailSaveOf, draftOf, sameDetailDraft } from './product-detail-draft.ts';
import type { DetailDraft } from './product-detail-draft.ts';

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

const failureOutcome = (error: CommandFailure): 'conflict' | 'failed' =>
  Predicate.isTagged(error, 'ManageCatalogActionConflictProblem') && error.code !== 'merchandise_lifecycle_conflict'
    ? 'conflict'
    : 'failed';

interface DetailSaveInput {
  /** The version the server last confirmed for this draft; the save sends what differs from it. */
  readonly confirmed: DetailDraft;
  readonly expectedRevision: number;
  /** Gets the approval notice of a refused save; a save that went through clears it. */
  readonly pending: (message: string | null) => void;
  readonly productId: ProductRecord['id'];
  readonly value: DetailDraft;
}

/**
 * One autosave of the detail form: the changed basic fields first, then a changed price. The first command expects
 * the revision the draft is based on, the second the one the first left. A conflict keeps the draft and offers the
 * version someone else saved.
 *
 * When the fields went through and the price did not, the server has the draft's fields with the confirmed price.
 * The save reports that version and its revision (`PartlySaved`): the retry then sends the price alone, and a field
 * typed back to its earlier value is sent as the change it now is, instead of comparing equal to a version the
 * server no longer has.
 */
const saveDetailEffect = ({
  confirmed,
  expectedRevision,
  pending,
  productId,
  value,
}: DetailSaveInput): Effect.Effect<DraftSaveResult<DetailDraft>> => {
  const { patch, priceChanged, priceMinor } = detailSaveOf(value, confirmed);
  const fieldsChanged = Object.keys(patch).length !== 0;
  if (!fieldsChanged && !priceChanged) {
    return Effect.succeed('saved');
  }
  const refused = (error: CommandFailure) => {
    pending(pendingProposalMessage(error) ?? null);
    return failureOutcome(error);
  };
  const saved = (revision: number) => {
    pending(null);
    return revision;
  };
  const update: Effect.Effect<number, CommandFailure> = fieldsChanged
    ? runProductCommand({ _tag: 'UpdateProduct', id: productId, patch }, expectedRevision)
    : Effect.succeed(expectedRevision);
  return update.pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.succeed<DraftSaveResult<DetailDraft>>(refused(error)),
      onSuccess: (revision) =>
        priceChanged
          ? runProductCommand({ _tag: 'ChangePrice', id: productId, priceMinor }, revision).pipe(
              Effect.match({
                onFailure: (error): DraftSaveResult<DetailDraft> => {
                  const outcome = refused(error);
                  return fieldsChanged
                    ? {
                        confirmed: { ...value, priceCzk: confirmed.priceCzk, priceText: confirmed.priceText },
                        outcome,
                        revision,
                      }
                    : outcome;
                },
                onSuccess: (next): DraftSaveResult<DetailDraft> => saved(next),
              }),
            )
          : Effect.sync((): DraftSaveResult<DetailDraft> => saved(revision)),
    }),
  );
};

/** The revision a chain of this page's own stock commands left behind, starting from the one they replaced. */
const afterStockCommits = (commits: ReadonlyMap<number, number>, revision: number): number => {
  const next = commits.get(revision);
  return next === undefined ? revision : afterStockCommits(commits, next);
};

interface ProductDetailAutosaveOptions {
  readonly product: ProductRecord;
  /** The catalog revision `product` was read at. */
  readonly revision: number;
}

/**
 * Draft and autosave of the product detail form. The editor stays mounted while its product reloads: an untouched
 * draft takes the reloaded product, a changed one stays and keeps expecting the revision it was based on
 * (`useAutosaveDraft`), so a change someone else made in the meantime ends in a conflict instead of being overwritten.
 *
 * `product` still shows the version before the form's own save until its reload lands, so a save sends what differs
 * from the version the server last confirmed, not from `product`.
 */
export const useProductDetailAutosave = ({ product, revision }: ProductDetailAutosaveOptions) => {
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  // Real variants are read-only on the detail tab and always come from the latest product.
  // Deriving them preserves unsaved detail fields when the variants tab commits a change.
  const realVariants = (product.variants ?? []).filter(isRealVariant);
  const stockCommits = useRef(new Map<number, number>());
  const autosave = useAutosaveDraft<DetailDraft, never>({
    equals: sameDetailDraft,
    isValid: (value) => !detailDraftInvalid(value),
    revision,
    runtime: browserRuntime,
    save: (value, expectedRevision, confirmed) =>
      saveDetailEffect({
        confirmed: { ...confirmed, realVariants },
        expectedRevision: afterStockCommits(stockCommits.current, expectedRevision),
        pending: setPendingMessage,
        productId: product.id,
        value: { ...value, realVariants },
      }),
    server: draftOf(product),
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
  return { autosave, draft: { ...autosave.draft, realVariants }, followStockCommit, pendingMessage };
};
