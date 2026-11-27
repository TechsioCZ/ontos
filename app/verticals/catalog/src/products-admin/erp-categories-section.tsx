// The ERP catalogue's Categories on the staff product list (Produkty z ERP): every ACTIVE Category with the products
// and subcategories in it. An empty one is retired through Catalog's own Action; the list reloads afterwards.
import { releaseGone } from '@app/shared-contracts';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Effect, Option, Schema } from 'effect';
import { useState } from 'react';

import {
  RetireProductCategoryPayloadSchema,
  RetireProductCategoryResultSchema,
} from '../../shared/actions/retire-product-category.ts';
import type { ProductPageCategory } from '../../shared/apis/product-page.ts';
import { executeRetireProductCategory } from '../api/retire-product-category-action-client.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { requestId } from './browser-crypto.ts';
import { productListData } from './page-data.ts';
import { RELOAD_REQUIRED, ReloadRequiredNotice } from './reload-required-notice.tsx';

/** Every generated Action problem carries a tag; Catalog's refusals also name a code. */
interface Problem {
  readonly _tag: string;
  readonly code?: unknown;
}

/** Catalog refuses a Category that still has a product or a subcategory, in any lifecycle. */
const isEmpty = (category: ProductPageCategory) => category.products === 0 && category.children === 0;

/** Why Catalog did not retire the Category, in the operator's words. */
export const retireFailure = (problem: Problem): string => {
  if (releaseGone(problem)) {
    return RELOAD_REQUIRED;
  }
  if (problem.code === 'category_reference_conflict') {
    return 'Kategorii nelze vyřadit: obsahuje produkty nebo podkategorie. Nejdřív je z ní odeberte.';
  }
  if (
    problem.code === 'category_revision_conflict' ||
    problem.code === 'category_conflict' ||
    problem.code === 'category_not_found'
  ) {
    return 'Kategorie se mezitím změnila. Načtěte stránku a zkuste to znovu.';
  }
  if (problem.code === 'action_permission_denied') {
    return 'Na vyřazení kategorie nemáte oprávnění.';
  }
  return `Kategorii se nepodařilo vyřadit (${problem._tag}). Zkuste to znovu.`;
};

const retire = (category: ProductPageCategory, reason: string) =>
  Schema.decodeEffect(RetireProductCategoryPayloadSchema)({
    categoryRef: category.categoryRef,
    expectedRevision: category.revision,
    reason,
  }).pipe(
    Effect.flatMap((payload) =>
      requestId.pipe(Effect.flatMap((id) => executeRetireProductCategory(payload, id, { idempotencyKey: id }))),
    ),
    Effect.mapError((problem: Problem) => retireFailure(problem)),
  );

interface Outcome {
  readonly status: 'error' | 'success';
  readonly text: string;
}

export const ErpCategoriesSection = ({ categories }: { readonly categories: readonly ProductPageCategory[] }) => {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const confirm = (category: ProductPageCategory) => {
    const text = reason.trim();
    if (text === '') {
      setOutcome({ status: 'error', text: 'Vyplňte důvod vyřazení.' });
      return;
    }
    setBusy(true);
    setOutcome(null);
    browserRuntime.runFork(
      retire(category, text).pipe(
        Effect.match({
          onFailure: (failure: string) => {
            setBusy(false);
            setOutcome({ status: 'error', text: failure });
          },
          onSuccess: (result) => {
            setBusy(false);
            setConfirming(null);
            setReason('');
            setOutcome(
              Option.isSome(Schema.decodeUnknownOption(RetireProductCategoryResultSchema)(result))
                ? { status: 'success', text: `Kategorie „${category.name}“ je vyřazená.` }
                : { status: 'success', text: 'Vyřazení kategorie čeká na schválení.' },
            );
            productListData.invalidate();
          },
        }),
      ),
    );
  };
  return (
    <details className="rounded-lg border border-border-primary p-250" data-erp-categories="">
      <summary className="cursor-pointer font-semibold">Kategorie z ERP ({categories.length})</summary>
      <div className="flex flex-col gap-150 pt-150">
        <p className="max-w-prose text-fg-secondary text-sm">
          Prázdnou kategorii (bez produktů a podkategorií) můžete vyřadit; v nabídce kategorií pak už nebude. Má-li
          kategorie produkty, nejdřív je z ní odeberte v úpravě produktu.
        </p>
        {outcome?.text === RELOAD_REQUIRED && <ReloadRequiredNotice />}
        {outcome !== null && outcome.text !== RELOAD_REQUIRED && (
          <StatusText showIcon status={outcome.status}>
            {outcome.text}
          </StatusText>
        )}
        {categories.length === 0 ? (
          <span className="text-fg-secondary text-sm">Žádné kategorie.</span>
        ) : (
          <Table size="sm" variant="line">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Kategorie</Table.ColumnHeader>
                <Table.ColumnHeader>Produkty</Table.ColumnHeader>
                <Table.ColumnHeader>Podkategorie</Table.ColumnHeader>
                <Table.ColumnHeader />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {categories.map((category) => {
                const id = category.categoryRef.resourceId;
                return (
                  <Table.Row data-category-id={id} key={id}>
                    <Table.Cell>{category.name}</Table.Cell>
                    <Table.Cell>{category.products}</Table.Cell>
                    <Table.Cell>{category.children}</Table.Cell>
                    <Table.Cell>
                      {!isEmpty(category) && <span className="text-fg-secondary text-xs">Není prázdná</span>}
                      {isEmpty(category) && confirming !== id && (
                        <Button
                          disabled={busy}
                          onClick={() => {
                            setConfirming(id);
                            setReason('');
                            setOutcome(null);
                          }}
                          size="sm"
                          theme="outlined"
                          type="button"
                          variant="secondary"
                        >
                          Vyřadit
                        </Button>
                      )}
                      {isEmpty(category) && confirming === id && (
                        <div className="flex flex-wrap items-center gap-100">
                          <Input
                            aria-label="Důvod vyřazení"
                            maxLength={1000}
                            onChange={(event) => setReason(event.target.value)}
                            placeholder="Důvod vyřazení"
                            size="sm"
                            value={reason}
                          />
                          <Button
                            isLoading={busy}
                            loadingText="Vyřazuji…"
                            onClick={() => confirm(category)}
                            size="sm"
                            type="button"
                            variant="primary"
                          >
                            Potvrdit vyřazení
                          </Button>
                          <Button
                            disabled={busy}
                            onClick={() => setConfirming(null)}
                            size="sm"
                            theme="outlined"
                            type="button"
                            variant="secondary"
                          >
                            Zrušit
                          </Button>
                        </div>
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        )}
      </div>
    </details>
  );
};
