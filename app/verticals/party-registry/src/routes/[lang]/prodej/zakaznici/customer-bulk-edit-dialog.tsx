import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { RadioGroup } from '@techsio/ui-kit/molecules/radio-group';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SidePanel } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { useState } from 'react';

import type { CustomerListItem } from '../../../../api/customers-client.ts';
import { archiveCustomer } from '../../../../api/customers-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { bulkArchiveReason } from './customers-model.ts';

const KEY = 'party-registry.pages.customers.bulkEdit';

/**
 * One tag action opens the shared BulkTagDialog, which asks for the tag and owns the add/remove choice,
 * so the next step never repeats a choice made here.
 */
export const BulkEditActionSchema = Schema.Literals(['archive', 'tags']);
export type BulkEditAction = typeof BulkEditActionSchema.Type;

const parseAction = (value: string | null): BulkEditAction => (value === 'archive' ? 'archive' : 'tags');

type ArchiveError = Effect.Error<ReturnType<typeof archiveCustomer>>;

interface ArchiveOutcome {
  readonly customer: CustomerListItem;
  readonly failure: Option.Option<ArchiveError>;
}

const advanceCount = (count: number) => count + 1;

/** Archives one customer. A failure is kept on its outcome so the batch keeps going and reports per row. */
const archiveOne = (customer: CustomerListItem, onStep: () => void) =>
  archiveCustomer(customer, bulkArchiveReason).pipe(
    Effect.match({
      onFailure: (failure): ArchiveOutcome => ({ customer, failure: Option.some(failure) }),
      onSuccess: (): ArchiveOutcome => ({ customer, failure: Option.none() }),
    }),
    Effect.tap(() => Effect.sync(onStep)),
  );

export interface CustomerBulkEditDialogProps {
  readonly items: readonly CustomerListItem[];
  readonly onArchived: () => void;
  readonly onChooseTag: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}

export const CustomerBulkEditDialog = ({
  items,
  onArchived,
  onChooseTag,
  onOpenChange,
  open,
}: CustomerBulkEditDialogProps) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [action, setAction] = useState<BulkEditAction>('tags');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const activeItems = items.filter((item) => item.status === 'ACTIVE');
  const advance = () => setDone(advanceCount);

  const close = () => {
    setNotice(null);
    setFailed([]);
    onOpenChange(false);
  };

  const finish = (outcomes: readonly ArchiveOutcome[]) => {
    const failures: string[] = [];
    let archived = 0;
    for (const outcome of outcomes) {
      if (Option.isSome(outcome.failure)) {
        failures.push(outcome.customer.displayName ?? outcome.customer.counterpartyId);
      } else {
        archived += 1;
      }
    }
    setBusy(false);
    setFailed(failures);
    if (archived > 0) {
      toaster.create({ title: t(`${KEY}.toastArchived`, { archived }), type: 'success' });
    }
    // Archived rows change the list even when some rows failed, so the parent always reloads.
    onArchived();
    if (failures.length === 0) {
      close();
    }
  };

  const archive = () => {
    if (activeItems.length === 0) {
      setNotice(t(`${KEY}.archiveNothing`));
      return;
    }
    setBusy(true);
    setDone(0);
    setFailed([]);
    setNotice(null);
    void browserRuntime.runPromise(
      Effect.forEach(activeItems, (customer) => archiveOne(customer, advance), { concurrency: 1 }).pipe(
        Effect.map(finish),
      ),
    );
  };

  const submit = () => {
    if (action === 'archive') {
      archive();
      return;
    }
    close();
    onChooseTag();
  };

  return (
    <SidePanel
      actions={
        <>
          <Button disabled={busy} onClick={() => close()} size="sm" theme="outlined" variant="secondary">
            {t(`${KEY}.cancel`)}
          </Button>
          <Button
            disabled={items.length === 0}
            isLoading={busy}
            loadingText={t(`${KEY}.busy`)}
            onClick={() => submit()}
            size="sm"
            variant="primary"
          >
            {action === 'archive' ? t(`${KEY}.submit`) : t(`${KEY}.continue`)}
          </Button>
        </>
      }
      description={t(`${KEY}.selected`, { total: items.length })}
      onOpenChange={(next) => {
        if (!next && !busy) {
          close();
        }
      }}
      open={open}
      size="sm"
      title={t(`${KEY}.title`)}
    >
      <div className="flex flex-col gap-200 py-200">
        <RadioGroup onValueChange={(next) => setAction(parseAction(next))} size="sm" value={action}>
          <RadioGroup.Label>{t(`${KEY}.actionLabel`)}</RadioGroup.Label>
          <RadioGroup.ItemGroup>
            <RadioGroup.Item value="tags">
              <RadioGroup.ItemHiddenInput />
              <RadioGroup.ItemControl />
              <RadioGroup.ItemText>{t(`${KEY}.actionTags`)}</RadioGroup.ItemText>
            </RadioGroup.Item>
            <RadioGroup.Item value="archive">
              <RadioGroup.ItemHiddenInput />
              <RadioGroup.ItemControl />
              <RadioGroup.ItemText>{t(`${KEY}.actionArchive`)}</RadioGroup.ItemText>
            </RadioGroup.Item>
          </RadioGroup.ItemGroup>
        </RadioGroup>
        {action === 'archive' && !busy && failed.length === 0 && (
          <p className="text-sm">{t(`${KEY}.archiveConfirm`, { total: activeItems.length })}</p>
        )}
        {busy && <p className="text-sm">{t(`${KEY}.progress`, { done, total: activeItems.length })}</p>}
        {notice !== null && <StatusText status="error">{notice}</StatusText>}
        {failed.length > 0 && (
          <StatusText showIcon status="error">
            {t(`${KEY}.archiveFailed`, { names: failed.join(', ') })}
          </StatusText>
        )}
      </div>
    </SidePanel>
  );
};
