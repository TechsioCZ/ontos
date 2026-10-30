// S02 inventura: inventory lists by property, found / missing / difference marks, follow-up tasks for differences
// (S02-03) and closing. Owned by ops-assets.
import { EmptyState, SectionCard } from '@app/admin-ui';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Table } from '@techsio/ui-kit/organisms/table';
import type { Effect } from 'effect';
import type { TOptions } from 'i18next';
import { useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type {
  Asset,
  AssetsState,
  Inventory,
  InventoryItem,
  InventoryResult,
} from '../../../../../shared/domain/assets.ts';
import { dueBadgeVariant, dueState, instantLabel, isoDateLabel, principalLabel, todayIsoDate } from './assets-model.ts';

const useK = () => {
  const { t } = useModernI18n();
  return (key: string, options?: TOptions) => t(`facility-operations.assets.${key}`, options);
};

const resultVariants = { difference: 'warning', found: 'success', missing: 'danger', pending: 'outline' } as const;
export const resultVariant = (result: InventoryResult) => resultVariants[result];

const markVariants = { difference: 'warning', found: 'secondary', missing: 'danger' } as const;

const counts = (inventory: Inventory) => ({
  differences: inventory.items.filter((item) => item.result === 'missing' || item.result === 'difference').length,
  found: inventory.items.filter((item) => item.result === 'found').length,
  pending: inventory.items.filter((item) => item.result === 'pending').length,
  total: inventory.items.length,
});

const ItemActions = ({
  busy,
  inventory,
  item,
  onFollowUp,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly inventory: Inventory;
  readonly item: InventoryItem;
  readonly onFollowUp: (item: InventoryItem) => void;
  readonly onSubmit: (command: OpsCommand, successKey: string) => Effect.Effect<boolean>;
}) => {
  const k = useK();
  const mark = (result: InventoryResult) => {
    void browserRuntime.runPromise(
      onSubmit(
        { _tag: 'AssetInventoryMark', assetId: item.assetId, inventoryId: inventory.id, result },
        'messages.marked',
      ),
    );
  };
  if (inventory.status === 'closed') {
    return null;
  }
  const isDifference = item.result === 'missing' || item.result === 'difference';
  return (
    <span className="flex flex-wrap justify-end gap-50">
      {item.followUp === undefined &&
        (['found', 'missing', 'difference'] as const)
          .filter((result) => result !== item.result)
          .map((result) => (
            <Button
              disabled={busy}
              key={result}
              onClick={() => mark(result)}
              size="sm"
              theme="outlined"
              variant={markVariants[result]}
            >
              {k(`inventory.mark.${result}`)}
            </Button>
          ))}
      {isDifference && item.followUp === undefined && (
        <Button disabled={busy} onClick={() => onFollowUp(item)} size="sm" variant="primary">
          {k('inventory.createFollowUp')}
        </Button>
      )}
      {item.followUp?.status === 'open' && (
        <Button
          disabled={busy}
          onClick={() => {
            void browserRuntime.runPromise(
              onSubmit(
                { _tag: 'AssetInventoryFollowUpResolve', assetId: item.assetId, inventoryId: inventory.id },
                'messages.followUpResolved',
              ),
            );
          }}
          size="sm"
          theme="outlined"
          variant="secondary"
        >
          {k('inventory.resolveFollowUp')}
        </Button>
      )}
    </span>
  );
};

export const InventoryTab = ({
  actor,
  busy,
  canWrite,
  onFollowUp,
  onNew,
  onOpenAsset,
  onSubmit,
  state,
}: {
  readonly actor: PrincipalRef | undefined;
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly onFollowUp: (inventory: Inventory, item: InventoryItem) => void;
  readonly onNew: () => void;
  readonly onOpenAsset: (asset: Asset) => void;
  readonly onSubmit: (command: OpsCommand, successKey: string) => Effect.Effect<boolean>;
  readonly state: AssetsState;
}) => {
  const k = useK();
  const inventories = (state.inventories ?? []).toSorted((left, right) => right.date.localeCompare(left.date));
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const selected =
    inventories.find((entry) => entry.id === selectedId) ??
    inventories.find((entry) => entry.status === 'open') ??
    inventories[0];
  const today = todayIsoDate();

  if (inventories.length === 0) {
    return (
      <EmptyState
        action={
          canWrite ? (
            <Button onClick={onNew} size="sm" theme="outlined" variant="secondary">
              {k('actions.newInventory')}
            </Button>
          ) : undefined
        }
        description={k('inventory.emptyDescription')}
        title={k('inventory.emptyTitle')}
      />
    );
  }
  const items =
    selected === undefined
      ? []
      : selected.items.filter((item) => !differencesOnly || item.result === 'missing' || item.result === 'difference');
  const stats = selected === undefined ? undefined : counts(selected);
  return (
    <div className="grid grid-cols-1 gap-250 lg:grid-cols-[18rem_1fr]">
      <div className="flex flex-col gap-150">
        {inventories.map((inventory) => {
          const summary = counts(inventory);
          const isSelected = inventory.id === selected?.id;
          return (
            <button
              className={`flex flex-col gap-50 rounded-lg border p-200 text-left transition-colors ${isSelected ? 'border-primary bg-surface' : 'border-border-primary bg-surface hover:bg-surface-hover'}`}
              key={inventory.id}
              onClick={() => setSelectedId(inventory.id)}
              type="button"
            >
              <span className="flex items-center justify-between gap-100">
                <span className="font-medium text-sm">{inventory.title}</span>
                <Badge size="sm" variant={inventory.status === 'open' ? 'info' : 'outline'}>
                  {k(`inventory.status.${inventory.status}`)}
                </Badge>
              </span>
              <span className="text-fg-secondary text-xs">
                {isoDateLabel(inventory.date)} · {inventory.scope?.label ?? k('inventory.wholeCompany')}
              </span>
              <span className="text-xs tabular-nums">
                {k('inventory.progress', { checked: summary.total - summary.pending, total: summary.total })}
                {summary.differences > 0 && (
                  <span className="ml-100 text-danger">
                    {k('inventory.differencesCount', { count: summary.differences })}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {selected !== undefined && stats !== undefined && (
        <SectionCard
          actions={
            <>
              <Button
                onClick={() => setDifferencesOnly((value) => !value)}
                size="sm"
                theme={differencesOnly ? 'solid' : 'outlined'}
                variant="secondary"
              >
                {k('inventory.differencesOnly', { count: stats.differences })}
              </Button>
              {canWrite && selected.status === 'open' && (
                <Button
                  disabled={busy || stats.pending > 0}
                  onClick={() => {
                    void browserRuntime.runPromise(
                      onSubmit({ _tag: 'AssetInventoryClose', inventoryId: selected.id }, 'messages.inventoryClosed'),
                    );
                  }}
                  size="sm"
                  variant="primary"
                >
                  {k('inventory.close')}
                </Button>
              )}
            </>
          }
          title={
            <span className="flex flex-wrap items-center gap-100">
              {selected.title}
              <Badge size="sm" variant={selected.status === 'open' ? 'info' : 'outline'}>
                {k(`inventory.status.${selected.status}`)}
              </Badge>
            </span>
          }
        >
          <div className="flex flex-wrap gap-200 text-sm">
            <span>{k('inventory.statFound', { count: stats.found })}</span>
            <span className="text-danger">{k('inventory.statDifferences', { count: stats.differences })}</span>
            <span className="text-fg-secondary">{k('inventory.statPending', { count: stats.pending })}</span>
            <span className="text-fg-secondary">
              {k('inventory.createdBy', {
                at: instantLabel(selected.createdAt),
                by: principalLabel(selected.createdBy, actor, k('you')),
              })}
            </span>
          </div>
          {selected.note !== undefined && <p className="text-fg-secondary text-sm">{selected.note}</p>}
          {selected.status === 'open' && stats.pending > 0 && canWrite && (
            <p className="text-fg-secondary text-xs">{k('inventory.closeHint')}</p>
          )}
          <Table size="sm" variant="line">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>{k('columns.asset')}</Table.ColumnHeader>
                <Table.ColumnHeader>{k('inventory.result')}</Table.ColumnHeader>
                <Table.ColumnHeader>{k('inventory.followUp')}</Table.ColumnHeader>
                <Table.ColumnHeader align="end">{canWrite ? k('inventory.actions') : ''}</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {items.map((item) => {
                const asset = state.assets.find((entry) => entry.id === item.assetId);
                return (
                  <Table.Row key={item.assetId}>
                    <Table.Cell>
                      <button
                        className="flex flex-col text-left hover:underline"
                        disabled={asset === undefined}
                        onClick={() => {
                          if (asset !== undefined) {
                            onOpenAsset(asset);
                          }
                        }}
                        type="button"
                      >
                        <span className="font-medium">{item.name}</span>
                        <span className="text-fg-secondary text-xs tabular-nums">
                          {item.inventoryNumber}
                          {asset?.location === undefined ? '' : ` · ${asset.location.label.split(' › ').at(-1) ?? ''}`}
                        </span>
                      </button>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="flex flex-col items-start gap-50">
                        <Badge size="sm" variant={resultVariant(item.result)}>
                          {k(`inventory.results.${item.result}`)}
                        </Badge>
                        {item.note !== undefined && <span className="text-fg-secondary text-xs">{item.note}</span>}
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      {item.followUp === undefined ? (
                        <span className="text-fg-secondary">—</span>
                      ) : (
                        <span className="flex flex-col items-start gap-50 text-sm">
                          <span>{item.followUp.title}</span>
                          <span className="flex flex-wrap items-center gap-50 text-fg-secondary text-xs">
                            {item.followUp.status === 'done' ? (
                              <Badge size="sm" variant="success">
                                {k('inventory.followUpDone')}
                              </Badge>
                            ) : (
                              <Badge size="sm" variant={dueBadgeVariant(dueState(item.followUp.dueDate, today))}>
                                {k('inventory.followUpDue', { date: isoDateLabel(item.followUp.dueDate) })}
                              </Badge>
                            )}
                            {item.followUp.assignee ?? ''}
                          </span>
                          {item.followUp.resolution !== undefined && (
                            <span className="text-fg-secondary text-xs">{item.followUp.resolution}</span>
                          )}
                        </span>
                      )}
                    </Table.Cell>
                    <Table.Cell align="end">
                      {canWrite && (
                        <ItemActions
                          busy={busy}
                          inventory={selected}
                          item={item}
                          onFollowUp={(entry) => onFollowUp(selected, entry)}
                          onSubmit={onSubmit}
                        />
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </SectionCard>
      )}
    </div>
  );
};
