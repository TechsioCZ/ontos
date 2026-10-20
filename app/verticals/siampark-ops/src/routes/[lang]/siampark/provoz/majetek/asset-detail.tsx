// Asset card (S02) in a resizable SidePanel: card, value/event timeline, revisions and depreciation (S03).
// Every action switches the panel body to its form; the footer carries Zpět + the submit button. Owned by ops-assets.
import { DetailList, SidePanel, formatMoney } from '@app/admin-ui';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { Table } from '@techsio/ui-kit/organisms/table';
import { useEffect, useState } from 'react';
import type { OpsCommand } from '../../../../../../shared/agendas.ts';
import type {
  Asset,
  AssetEvent,
  AssetsState,
  DepreciationPlan,
  DepreciationType,
} from '../../../../../../shared/domain/assets.ts';
import { assetStatusOf, currentServiceRecords, isActiveAsset } from '../../../../../../shared/domain/assets.ts';
import {
  AssetCardForm,
  DisposeForm,
  EntryForm,
  EventForm,
  PlanForm,
  ServiceForm,
  ValueChangeForm,
} from './asset-forms.tsx';
import {
  dueBadgeVariant,
  dueState,
  instantLabel,
  isoDateLabel,
  money,
  planOf,
  principalLabel,
  propertyHref,
  remainingOf,
  todayIsoDate,
} from './assets-model.ts';
import { CommentThread } from '../../../../../ui/comment-thread.tsx';
import { LinkedDocuments } from '../../../../../ui/linked-documents.tsx';
import { AssetDepreciation, ConnectionBadge } from './depreciation.tsx';

export type DetailMode =
  | { readonly kind: 'view' }
  | { readonly kind: 'edit' }
  | { readonly kind: 'value' }
  | { readonly kind: 'event' }
  | { readonly kind: 'dispose' }
  | { readonly kind: 'service' }
  | { readonly kind: 'plan'; readonly type: DepreciationType }
  | { readonly kind: 'entry'; readonly planId: string };

const FORM_ID = 'siampark-asset-detail-form';

const useK = () => {
  const { t } = useModernI18n();
  return (key: string, options?: Record<string, unknown>) => t(`siampark-ops.assets.${key}`, options);
};

export const KindBadge = ({ asset }: { readonly asset: Asset }) => {
  const k = useK();
  const kind = asset.kind ?? 'equipment';
  return (
    <Badge size="sm" variant={kind === 'building' ? 'info' : kind === 'technology' ? 'secondary' : 'outline'}>
      {k(`kind.${kind}`)}
    </Badge>
  );
};

export const StatusBadge = ({ asset }: { readonly asset: Asset }) => {
  const k = useK();
  return assetStatusOf(asset) === 'active' ? (
    <Badge size="sm" variant="success">
      {k('status.active')}
    </Badge>
  ) : (
    <Badge size="sm" variant="outline">
      {k(`disposal.${asset.disposal?.kind ?? 'retirement'}`)}
    </Badge>
  );
};

const eventTone = (event: AssetEvent) => {
  if (event.kind === 'value_change') {
    return 'bg-info';
  }
  if (event.kind === 'sale' || event.kind === 'retirement' || event.kind === 'liquidation') {
    return 'bg-danger';
  }
  if (event.kind === 'acquisition' || event.kind === 'placed_in_service') {
    return 'bg-success';
  }
  return 'bg-border-primary';
};

const Timeline = ({ actor, asset }: { readonly actor: PrincipalRef | undefined; readonly asset: Asset }) => {
  const k = useK();
  const events = (asset.events ?? []).toSorted((left, right) =>
    right.date === left.date ? right.id.localeCompare(left.id) : right.date.localeCompare(left.date),
  );
  if (events.length === 0) {
    return <p className="text-fg-secondary text-sm">{k('history.empty')}</p>;
  }
  return (
    <ol className="relative flex flex-col gap-250 border-border-primary border-l pl-250">
      {events.map((event) => (
        <li className="relative" key={event.id}>
          <span
            className={`absolute top-[0.35rem] -left-[1.4rem] h-[0.7rem] w-[0.7rem] rounded-full ${eventTone(event)}`}
          />
          <div className="flex flex-wrap items-baseline gap-100">
            <span className="font-medium text-sm">{k(`event.${event.kind}`)}</span>
            <span className="text-fg-secondary text-xs">{isoDateLabel(event.date)}</span>
          </div>
          {(event.previousValueMinor !== undefined || event.newValueMinor !== undefined) && (
            <p className="mt-50 text-sm tabular-nums">
              {event.previousValueMinor !== undefined && (
                <span className="text-fg-secondary line-through">{formatMoney(event.previousValueMinor)}</span>
              )}
              {event.previousValueMinor !== undefined && event.newValueMinor !== undefined && ' → '}
              {event.newValueMinor !== undefined && (
                <span className="font-semibold">{formatMoney(event.newValueMinor)}</span>
              )}
            </p>
          )}
          {event.note !== '' && <p className="mt-50 text-sm">{event.note}</p>}
          <p className="mt-50 text-fg-secondary text-xs">
            {event.documentRef === undefined ? '' : `${k('fields.documentRef')}: ${event.documentRef} · `}
            {k('history.recorded', { at: instantLabel(event.at), by: principalLabel(event.by, actor, k('you')) })}
          </p>
        </li>
      ))}
    </ol>
  );
};

const ServicesTable = ({ actor, asset }: { readonly actor: PrincipalRef | undefined; readonly asset: Asset }) => {
  const k = useK();
  const today = todayIsoDate();
  const current = new Set(currentServiceRecords(asset).map((record) => record.id));
  const records = (asset.services ?? []).toSorted((left, right) =>
    (right.performedOn ?? right.nextDueOn ?? '').localeCompare(left.performedOn ?? left.nextDueOn ?? ''),
  );
  if (records.length === 0) {
    return <p className="text-fg-secondary text-sm">{k('services.empty')}</p>;
  }
  return (
    <Table size="sm" variant="line">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeader>{k('fields.serviceTitle')}</Table.ColumnHeader>
          <Table.ColumnHeader>{k('fields.performedOn')}</Table.ColumnHeader>
          <Table.ColumnHeader>{k('fields.result')}</Table.ColumnHeader>
          <Table.ColumnHeader>{k('fields.nextDueOn')}</Table.ColumnHeader>
          <Table.ColumnHeader>{k('fields.supplier')}</Table.ColumnHeader>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {records.map((record) => (
          <Table.Row key={record.id}>
            <Table.Cell>
              <span className="flex flex-col">
                <span className="font-medium">{record.title}</span>
                <span className="text-fg-secondary text-xs">
                  {k(`serviceKind.${record.kind}`)}
                  {record.documentRef === undefined ? '' : ` · ${record.documentRef}`}
                  {` · ${principalLabel(record.by, actor, k('you'))}`}
                </span>
                {record.note !== undefined && <span className="text-fg-secondary text-xs">{record.note}</span>}
              </span>
            </Table.Cell>
            <Table.Cell>{isoDateLabel(record.performedOn)}</Table.Cell>
            <Table.Cell>
              {record.kind === 'permit' ? (
                <Badge
                  size="sm"
                  variant={
                    record.permitState === 'granted'
                      ? 'success'
                      : record.permitState === 'rejected' || record.permitState === 'expired'
                        ? 'danger'
                        : 'info'
                  }
                >
                  {k(`permit.${record.permitState ?? 'requested'}`)}
                </Badge>
              ) : record.result === undefined ? (
                '—'
              ) : (
                <Badge
                  size="sm"
                  variant={record.result === 'ok' ? 'success' : record.result === 'defects' ? 'warning' : 'danger'}
                >
                  {k(`result.${record.result}`)}
                </Badge>
              )}
            </Table.Cell>
            <Table.Cell>
              {record.nextDueOn === undefined ? (
                '—'
              ) : current.has(record.id) ? (
                <span className="flex flex-col items-start gap-50">
                  <span>{isoDateLabel(record.nextDueOn)}</span>
                  <Badge size="sm" variant={dueBadgeVariant(dueState(record.nextDueOn, today))}>
                    {k(`due.${dueState(record.nextDueOn, today)}`)}
                  </Badge>
                </span>
              ) : (
                <span className="text-fg-secondary line-through">{isoDateLabel(record.nextDueOn)}</span>
              )}
            </Table.Cell>
            <Table.Cell>{record.supplier ?? '—'}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
};

const CardTab = ({
  actor,
  asset,
  language,
}: {
  readonly actor: PrincipalRef | undefined;
  readonly asset: Asset;
  readonly language: string;
}) => {
  const k = useK();
  const missing = k('notProvided');
  const accounting = remainingOf(asset, 'accounting');
  const tax = remainingOf(asset, 'tax');
  return (
    <div className="flex flex-col gap-250">
      <div className="grid grid-cols-1 gap-150 sm:grid-cols-3">
        <div className="rounded-lg border border-border-primary bg-surface p-200">
          <p className="text-fg-secondary text-xs">{k('fields.acquisitionValue')}</p>
          <p className="font-semibold text-lg tabular-nums">{money(asset.acquisitionValueMinor, missing)}</p>
          <p className="text-fg-secondary text-xs">
            {asset.acquisitionDate === undefined ? missing : isoDateLabel(asset.acquisitionDate)}
          </p>
        </div>
        <div className="rounded-lg border border-border-primary bg-surface p-200">
          <p className="text-fg-secondary text-xs">{k('fields.currentValue')}</p>
          <p className="font-semibold text-lg tabular-nums">{money(asset.currentValueMinor, missing)}</p>
          <p className="text-fg-secondary text-xs">
            {asset.currentValueDate === undefined
              ? missing
              : k('card.confirmedOn', { date: isoDateLabel(asset.currentValueDate) })}
          </p>
        </div>
        <div className="rounded-lg border border-border-primary bg-surface p-200">
          <p className="text-fg-secondary text-xs">{k('card.bookValues')}</p>
          <p className="text-sm tabular-nums">
            {k('depreciation.accountingShort')}: <span className="font-semibold">{money(accounting, missing)}</span>
          </p>
          <p className="text-sm tabular-nums">
            {k('depreciation.taxShort')}: <span className="font-semibold">{money(tax, missing)}</span>
          </p>
        </div>
      </div>
      <DetailList
        items={[
          { label: k('fields.inventoryNumber'), value: <span className="tabular-nums">{asset.inventoryNumber}</span> },
          { label: k('fields.kind'), value: <KindBadge asset={asset} /> },
          { label: k('fields.category'), value: asset.category },
          { label: k('fields.serialNumber'), value: asset.serialNumber ?? missing },
          {
            label: k('fields.location'),
            value:
              asset.location === undefined ? (
                missing
              ) : asset.location.id.startsWith('label:') ? (
                asset.location.label
              ) : (
                <a
                  className="text-primary underline-offset-2 hover:underline"
                  href={propertyHref(language, asset.location.id)}
                >
                  {asset.location.label}
                </a>
              ),
          },
          { label: k('fields.responsible'), value: asset.responsible ?? missing },
          {
            label: k('fields.acquisitionMethod'),
            value: asset.acquisitionMethod === undefined ? missing : k(`method.${asset.acquisitionMethod}`),
          },
          {
            label: k('fields.placedInService'),
            value: asset.placedInServiceDate === undefined ? missing : isoDateLabel(asset.placedInServiceDate),
          },
          { label: k('depreciation.connection'), value: <ConnectionBadge asset={asset} /> },
          {
            label: k('depreciation.plans'),
            value: (
              <span className="flex flex-wrap gap-50">
                {(['accounting', 'tax'] as const).map((type) => {
                  const plan = planOf(asset, type);
                  return (
                    <Badge
                      key={type}
                      size="sm"
                      variant={plan === undefined ? 'outline' : plan.status === 'confirmed' ? 'success' : 'warning'}
                    >
                      {`${k(`depreciation.${type}`)}: ${plan === undefined ? k('depreciation.none') : k(`planStatus.${plan.status}`)}`}
                    </Badge>
                  );
                })}
              </span>
            ),
          },
          {
            label: k('card.created'),
            value: `${instantLabel(asset.createdAt)} · ${principalLabel(asset.createdBy, actor, k('you'))}`,
          },
          {
            label: k('card.updated'),
            value: `${instantLabel(asset.updatedAt)} · ${principalLabel(asset.updatedBy, actor, k('you'))}`,
          },
        ]}
      />
      {asset.disposal !== undefined && (
        <div className="flex flex-col gap-50 rounded-lg border border-border-primary bg-surface-secondary p-200 text-sm">
          <p className="font-medium">
            {k(`disposal.${asset.disposal.kind}`)} · {isoDateLabel(asset.disposal.date)}
          </p>
          <p>{asset.disposal.reason}</p>
          {asset.disposal.proceedsMinor !== undefined && (
            <p className="tabular-nums">
              {k('fields.proceeds')}: {formatMoney(asset.disposal.proceedsMinor)}
            </p>
          )}
          {asset.disposal.documentRef !== undefined && (
            <p className="text-fg-secondary">
              {k('fields.documentRef')}: {asset.disposal.documentRef}
            </p>
          )}
          <p className="text-fg-secondary text-xs">{k('card.disposedNote')}</p>
        </div>
      )}
      {asset.note !== undefined && (
        <div className="text-sm">
          <p className="text-fg-secondary text-xs">{k('fields.note')}</p>
          <p className="whitespace-pre-line">{asset.note}</p>
        </div>
      )}
    </div>
  );
};

export const AssetDetailPanel = ({
  actor,
  asset,
  busy,
  canWrite,
  language,
  onClose,
  onSubmit,
  state,
}: {
  readonly actor: PrincipalRef | undefined;
  readonly asset: Asset | undefined;
  readonly busy: boolean;
  readonly canWrite: boolean;
  readonly language: string;
  readonly onClose: () => void;
  /** Runs the command; resolves true when it was saved (the page reloads data and toasts). */
  readonly onSubmit: (command: OpsCommand, successKey: string) => Promise<boolean>;
  readonly state: AssetsState;
}) => {
  const k = useK();
  const [mode, setMode] = useState<DetailMode>({ kind: 'view' });
  const [tab, setTab] = useState('card');
  useEffect(() => {
    setMode({ kind: 'view' });
    setTab('card');
  }, [asset?.id]);

  if (asset === undefined) {
    return null;
  }
  const active = isActiveAsset(asset);
  const submit = (successKey: string, nextTab?: string) => (command: OpsCommand) => {
    void onSubmit(command, successKey).then((ok) => {
      if (ok) {
        setMode({ kind: 'view' });
        if (nextTab !== undefined) {
          setTab(nextTab);
        }
      }
    });
  };
  const confirmPlan = (plan: DepreciationPlan) => {
    void onSubmit(
      { _tag: 'AssetDepreciationPlanConfirm', assetId: asset.id, planId: plan.id },
      'messages.planConfirmed',
    );
  };
  const entryPlan =
    mode.kind === 'entry' ? (asset.depreciationPlans ?? []).find((plan) => plan.id === mode.planId) : undefined;

  const formTitle: Record<Exclude<DetailMode['kind'], 'view'>, string> = {
    dispose: k('actions.dispose'),
    edit: k('actions.edit'),
    entry: k('actions.recordEntry'),
    event: k('actions.recordEvent'),
    plan: mode.kind === 'plan' ? k(`actions.createPlan.${mode.type}`) : '',
    service: k('actions.recordService'),
    value: k('actions.changeValue'),
  };

  const body = (() => {
    switch (mode.kind) {
      case 'edit':
        return <AssetCardForm asset={asset} formId={FORM_ID} onSubmit={submit('messages.updated')} state={state} />;
      case 'value':
        return <ValueChangeForm asset={asset} formId={FORM_ID} onSubmit={submit('messages.valueChanged', 'history')} />;
      case 'event':
        return <EventForm asset={asset} formId={FORM_ID} onSubmit={submit('messages.eventRecorded', 'history')} />;
      case 'dispose':
        return <DisposeForm asset={asset} formId={FORM_ID} onSubmit={submit('messages.disposed', 'card')} />;
      case 'service':
        return <ServiceForm asset={asset} formId={FORM_ID} onSubmit={submit('messages.serviceRecorded', 'services')} />;
      case 'plan':
        return (
          <PlanForm
            asset={asset}
            formId={FORM_ID}
            onSubmit={submit('messages.planCreated', 'depreciation')}
            state={state}
            type={mode.type}
          />
        );
      case 'entry':
        return entryPlan === undefined ? null : (
          <EntryForm
            asset={asset}
            formId={FORM_ID}
            onSubmit={submit('messages.entryRecorded', 'depreciation')}
            plan={entryPlan}
          />
        );
      default:
        return (
          <Tabs onValueChange={setTab} value={tab} variant="line">
            <Tabs.List>
              <Tabs.Trigger value="card">{k('detail.tabs.card')}</Tabs.Trigger>
              <Tabs.Trigger value="history">
                {k('detail.tabs.history', { count: (asset.events ?? []).length })}
              </Tabs.Trigger>
              <Tabs.Trigger value="services">
                {k('detail.tabs.services', { count: (asset.services ?? []).length })}
              </Tabs.Trigger>
              <Tabs.Trigger value="depreciation">{k('detail.tabs.depreciation')}</Tabs.Trigger>
              <Tabs.Trigger value="documents">{k('detail.tabs.documents')}</Tabs.Trigger>
              <Tabs.Indicator />
            </Tabs.List>
            <Tabs.Content className="py-250" value="card">
              <CardTab actor={actor} asset={asset} language={language} />
            </Tabs.Content>
            <Tabs.Content className="flex flex-col gap-200 py-250" value="history">
              {canWrite && active && (
                <div className="flex flex-wrap gap-100">
                  <Button onClick={() => setMode({ kind: 'value' })} size="sm" theme="outlined" variant="secondary">
                    {k('actions.changeValue')}
                  </Button>
                  <Button onClick={() => setMode({ kind: 'event' })} size="sm" theme="outlined" variant="secondary">
                    {k('actions.recordEvent')}
                  </Button>
                </div>
              )}
              <Timeline actor={actor} asset={asset} />
            </Tabs.Content>
            <Tabs.Content className="flex flex-col gap-200 py-250" value="services">
              {canWrite && active && (
                <div>
                  <Button onClick={() => setMode({ kind: 'service' })} size="sm" theme="outlined" variant="secondary">
                    {k('actions.recordService')}
                  </Button>
                </div>
              )}
              <ServicesTable actor={actor} asset={asset} />
            </Tabs.Content>
            <Tabs.Content className="py-250" value="depreciation">
              <AssetDepreciation
                actor={actor}
                asset={asset}
                canWrite={canWrite}
                onConfirm={confirmPlan}
                onCreate={(type) => setMode({ kind: 'plan', type })}
                onRecord={(plan) => setMode({ kind: 'entry', planId: plan.id })}
              />
            </Tabs.Content>
            <Tabs.Content className="flex flex-col gap-300 py-250" value="documents">
              <LinkedDocuments subject={{ id: asset.id, kind: 'asset', label: `${asset.inventoryNumber} · ${asset.name}` }} />
              <CommentThread subject={{ id: asset.id, kind: 'asset', label: `${asset.inventoryNumber} · ${asset.name}` }} />
            </Tabs.Content>
          </Tabs>
        );
    }
  })();

  return (
    <SidePanel
      actions={
        mode.kind === 'view' ? (
          <>
            <Button onClick={onClose} theme="outlined" variant="secondary">
              {k('actions.close')}
            </Button>
            {canWrite && active && (
              <>
                <Button onClick={() => setMode({ kind: 'dispose' })} theme="outlined" variant="danger">
                  {k('actions.dispose')}
                </Button>
                <Button onClick={() => setMode({ kind: 'edit' })} variant="primary">
                  {k('actions.edit')}
                </Button>
              </>
            )}
          </>
        ) : (
          <>
            <Button onClick={() => setMode({ kind: 'view' })} theme="outlined" variant="secondary">
              {k('actions.back')}
            </Button>
            <Button
              form={FORM_ID}
              isLoading={busy}
              loadingText={k('saving')}
              type="submit"
              variant={mode.kind === 'dispose' ? 'danger' : 'primary'}
            >
              {mode.kind === 'dispose' ? k('actions.confirmDispose') : k('actions.save')}
            </Button>
          </>
        )
      }
      closeOnInteractOutside={mode.kind === 'view'}
      description={
        <span className="flex flex-wrap items-center gap-100">
          <span className="tabular-nums">{asset.inventoryNumber}</span>
          <span>·</span>
          <span>{asset.location?.label ?? k('notProvided')}</span>
          <KindBadge asset={asset} />
          <StatusBadge asset={asset} />
        </span>
      }
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      resizeLabel={k('resize')}
      size="xl"
      title={mode.kind === 'view' ? asset.name : `${formTitle[mode.kind]} · ${asset.name}`}
    >
      {body}
    </SidePanel>
  );
};
