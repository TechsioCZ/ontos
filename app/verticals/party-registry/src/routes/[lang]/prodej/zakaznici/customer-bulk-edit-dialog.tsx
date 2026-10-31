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
import { isCustomerWriteForbidden } from './customers-data.ts';
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
  /** `none` when archived, or when the batch stopped before this row because the owner refused the role. */
  readonly failure: Option.Option<ArchiveError>;
  readonly skipped?: true;
}

const advanceCount = (count: number) => count + 1;

/** Archives run a few at a time: each one waits for its own gateway assertion, so one by one took half a minute. */
const ARCHIVE_CONCURRENCY = 4;

interface ArchiveBatch {
  /** Set by the first 403: every other row would be refused the same way, so the rest are not sent. */
  forbidden: boolean;
}

/** Archives one customer. A failure is kept on its outcome so the batch keeps going and reports per row. */
const archiveOne = (customer: CustomerListItem, batch: ArchiveBatch, onStep: () => void) =>
  batch.forbidden
    ? Effect.succeed<ArchiveOutcome>({ customer, failure: Option.none(), skipped: true })
    : archiveCustomer(customer, bulkArchiveReason).pipe(
        Effect.match({
          onFailure: (failure): ArchiveOutcome => {
            if (isCustomerWriteForbidden(failure)) {
              batch.forbidden = true;
            }
            return { customer, failure: Option.some(failure) };
          },
          onSuccess: (): ArchiveOutcome => ({ customer, failure: Option.none() }),
        }),
        Effect.tap(() => Effect.sync(onStep)),
      );

export interface CustomerBulkEditDialogProps {
  /** False without tagging write: the tag action is left out and archive is the only choice. */
  readonly canTag: boolean;
  readonly items: readonly CustomerListItem[];
  readonly onArchived: () => void;
  readonly onChooseTag: () => void;
  readonly onOpenChange: (open: boolean) => void;
  /** The owner refused an archive with 403: this role may not write customers. */
  readonly onWriteRefused: () => void;
  readonly open: boolean;
}

export const CustomerBulkEditDialog = ({
  canTag,
  items,
  onArchived,
  onChooseTag,
  onOpenChange,
  onWriteRefused,
  open,
}: CustomerBulkEditDialogProps) => {
  const { t } = useModernI18n();
  const toaster = useToast();
  const [chosenAction, setChosenAction] = useState<BulkEditAction>('tags');
  // Without tagging write the tag choice is not offered, so archive is the action whatever was chosen before.
  const action: BulkEditAction = canTag ? chosenAction : 'archive';
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const activeItems = items.filter((item) => item.status === 'ACTIVE');
  const advance = () => setDone(advanceCount);

  // The dialog stays mounted, so the action resets to the neutral tag choice; a reopen never preselects archive.
  const close = () => {
    setChosenAction('tags');
    setNotice(null);
    setFailed([]);
    onOpenChange(false);
  };

  const finish = (outcomes: readonly ArchiveOutcome[], batch: ArchiveBatch) => {
    if (batch.forbidden) {
      // A refused role archived nothing, so the reason replaces the per-row list.
      setBusy(false);
      setNotice(t(`${KEY}.archiveForbidden`));
      onWriteRefused();
      return;
    }
    const failures: string[] = [];
    let archived = 0;
    for (const outcome of outcomes) {
      if (outcome.skipped === true) {
        continue;
      }
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
    const batch: ArchiveBatch = { forbidden: false };
    void browserRuntime.runPromise(
      Effect.forEach(activeItems, (customer) => archiveOne(customer, batch, advance), {
        concurrency: ARCHIVE_CONCURRENCY,
      }).pipe(Effect.map((outcomes) => finish(outcomes, batch))),
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
      resizeLabel={t('party-registry.sidePanel.resize')}
      size="md"
      title={t(`${KEY}.title`)}
    >
      <div className="flex flex-col gap-200 py-200">
        <RadioGroup onValueChange={(next) => setChosenAction(parseAction(next))} size="sm" value={action}>
          <RadioGroup.Label>{t(`${KEY}.actionLabel`)}</RadioGroup.Label>
          <RadioGroup.ItemGroup>
            {canTag && (
              <RadioGroup.Item value="tags">
                <RadioGroup.ItemHiddenInput />
                <RadioGroup.ItemControl />
                <RadioGroup.ItemText>{t(`${KEY}.actionTags`)}</RadioGroup.ItemText>
              </RadioGroup.Item>
            )}
            <RadioGroup.Item value="archive">
              <RadioGroup.ItemHiddenInput />
              <RadioGroup.ItemControl />
              <RadioGroup.ItemText>{t(`${KEY}.actionArchive`)}</RadioGroup.ItemText>
            </RadioGroup.Item>
          </RadioGroup.ItemGroup>
        </RadioGroup>
        {action === 'archive' && !busy && failed.length === 0 && (
          <p className="text-sm">{t(`${KEY}.archiveConfirm`, { count: activeItems.length })}</p>
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
