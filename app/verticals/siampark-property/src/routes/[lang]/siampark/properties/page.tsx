import { UnitRefSchema } from '../../../../../shared/resources/unit.ts';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Link } from '@techsio/ui-kit/atoms/link';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { executeRecords as readAgreements } from '@app/siampark-agreements/clients/records';
import { executeRecords as readOccupancy } from '@app/siampark-occupancy/clients/records';
import { executeRecords as readFinance } from '@app/siampark-billing-finance/clients/records';
import { executeRecords as readWork } from '@app/siampark-work/clients/records';
import { Effect, Match, Option, Random, Result, Schema } from 'effect';
import { useEffect, useEffectEvent, useState } from 'react';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { usePropertyEditor } from './use-property-editor.ts';
import { executeRecords } from '../../../../api/records-client';
import type { RecordsResponse } from '../../../../../shared/apis/records';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/siampark-property.json';
import enResource from '../../../../../locales/en/siampark-property.json';
import '../../../index.css';

const currencyFormatters = {
  cs: new Intl.NumberFormat('cs-CZ', { currency: 'CZK', style: 'currency' }),
  en: new Intl.NumberFormat('en-GB', { currency: 'CZK', style: 'currency' }),
};
const searchSchema = Schema.Struct({
  resourceId: Schema.optional(UnitRefSchema.fields.resourceId.check(Schema.isUUID())),
});
const siamparkPropertyI18nResources = {
  cs: { 'siampark-property': csResource },
  en: { 'siampark-property': enResource },
} as const;

type Agreements = Effect.Success<ReturnType<typeof readAgreements>>;
type Occupancies = Effect.Success<ReturnType<typeof readOccupancy>>;
type Work = Effect.Success<ReturnType<typeof readWork>>;
interface RelatedSources {
  readonly agreements?:
    | {
        readonly contracts: readonly Pick<
          Agreements['contracts'][number],
          'contractRef' | 'endDate' | 'lifecycleState' | 'propertyRef' | 'startDate' | 'unitRef'
        >[];
        readonly documents: readonly Pick<
          Agreements['documents'][number],
          'contractRef' | 'documentRef' | 'fileName' | 'signedDocumentReference' | 'title'
        >[];
      }
    | undefined;
  readonly assets: readonly Pick<RecordsResponse['assets'][number], 'assetRef'>[];
  readonly occupancy?:
    | {
        readonly occupancies: readonly Pick<
          Occupancies['occupancies'][number],
          'endDate' | 'occupancyRef' | 'startDate' | 'state' | 'unitRef'
        >[];
      }
    | undefined;
  readonly property?: Pick<RecordsResponse['properties'][number], 'propertyRef'> | undefined;
  readonly units: readonly Pick<RecordsResponse['units'][number], 'unitRef'>[];
  readonly work?:
    | { readonly items: readonly Pick<Work['items'][number], 'contextRefs' | 'ref' | 'title'>[] }
    | undefined;
}
export const projectPropertyRelatedRecords = ({
  agreements,
  assets,
  occupancy,
  property,
  units,
  work,
}: RelatedSources) => {
  const activeOccupancies =
    occupancy?.occupancies.filter(
      (item) =>
        item.state === 'ACTIVE' &&
        units.some(
          (record) =>
            record.unitRef.tenantId === item.unitRef.tenantId && record.unitRef.resourceId === item.unitRef.resourceId,
        ),
    ) ?? [];
  const propertyContracts =
    agreements?.contracts.filter(
      (item) =>
        property !== undefined &&
        ((item.propertyRef?.tenantId === property.propertyRef.tenantId &&
          item.propertyRef.resourceId === property.propertyRef.resourceId) ||
          (item.propertyRef === null &&
            units.some(
              (record) =>
                record.unitRef.tenantId === item.unitRef?.tenantId &&
                record.unitRef.resourceId === item.unitRef.resourceId,
            ))),
    ) ?? [];
  const propertyDocuments =
    agreements?.documents.filter((item) =>
      propertyContracts.some(
        (record) =>
          record.contractRef.tenantId === item.contractRef?.tenantId &&
          record.contractRef.resourceId === item.contractRef.resourceId,
      ),
    ) ?? [];
  const propertyTasks =
    work?.items.filter((item) =>
      item.contextRefs.some((reference) =>
        [
          ...(property === undefined ? [] : [property.propertyRef]),
          ...units.map((record) => record.unitRef),
          ...assets.map((record) => record.assetRef),
        ].some(
          (owned) =>
            reference.tenantId === owned.tenantId &&
            reference.moduleId === owned.moduleId &&
            reference.resourceType === owned.resourceType &&
            reference.resourceId === owned.resourceId,
        ),
      ),
    ) ?? [];
  return { activeOccupancies, propertyContracts, propertyDocuments, propertyTasks };
};
const usePropertyRecords = () => {
  const { language, t } = useModernI18n();
  const rawSearch: unknown = useRouterState().location.search;
  const search = Schema.is(Schema.toEncoded(searchSchema))(rawSearch)
    ? Schema.decodeOption(searchSchema)(rawSearch)
    : Option.none();
  const resourceId = Option.getOrUndefined(search)?.resourceId;
  const key = 'siampark-property.pages.records';
  const [records, setRecords] = useState<RecordsResponse>();
  const [selection, setSelection] = useState({ assetId: '', propertyId: '', unitId: '' });
  const { assetId, propertyId, unitId } = selection;
  const setUnitId = (selectedUnitId: string) => setSelection((current) => ({ ...current, unitId: selectedUnitId }));
  const setAssetId = (selectedAssetId: string) => setSelection((current) => ({ ...current, assetId: selectedAssetId }));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [summary, setSummary] = useState<{
    readonly agreements?: Effect.Success<ReturnType<typeof readAgreements>> | undefined;
    readonly finance?: Effect.Success<ReturnType<typeof readFinance>> | undefined;
    readonly occupancy?: Effect.Success<ReturnType<typeof readOccupancy>> | undefined;
    readonly work?: Effect.Success<ReturnType<typeof readWork>> | undefined;
  }>({});
  const { agreements, finance, occupancy, work } = summary;
  const [summaryMessage, setSummaryMessage] = useState('');
  const selectProperty = (selectedPropertyId: string) => {
    setSelection({ assetId: '', propertyId: selectedPropertyId, unitId: '' });
    setSummary({});
    setSummaryMessage('');
  };
  const refresh = () => {
    setPending(true);
    void browserRuntime.runPromise(
      Random.nextInt.pipe(
        Effect.flatMap((id) => executeRecords({}, `siampark-properties:${id}`)),
        Effect.match({
          onFailure: (error) => {
            setRecords(undefined);
            setSummary({});
            setMessage(
              Match.value(error).pipe(
                Match.tag('RecordsForbiddenProblem', () => t(`${key}.forbidden`)),
                Match.orElse(() => t(`${key}.unavailable`)),
              ),
            );
            setPending(false);
          },
          onSuccess: (result) => {
            setRecords(result);
            const selectedUnit = result.units.find((item) => item.unitRef.resourceId === resourceId);
            const selectedAsset = result.assets.find((item) => item.assetRef.resourceId === resourceId);
            const selectedProperty = result.properties.find((item) => item.propertyRef.resourceId === resourceId);
            setSelection({
              assetId: selectedAsset?.assetRef.resourceId ?? '',
              propertyId:
                selectedProperty?.propertyRef.resourceId ??
                selectedUnit?.propertyRef.resourceId ??
                selectedAsset?.propertyRef.resourceId ??
                '',
              unitId: selectedUnit?.unitRef.resourceId ?? '',
            });
            setSummary({});
            setMessage('');
            setPending(false);
          },
        }),
      ),
    );
  };
  const property = records?.properties.find((item) => item.propertyRef.resourceId === propertyId);
  const units = records?.units.filter((item) => item.propertyRef.resourceId === propertyId) ?? [];
  const assets = records?.assets.filter((item) => item.propertyRef.resourceId === propertyId) ?? [];
  const unit = units.find((item) => item.unitRef.resourceId === unitId);
  const asset = assets.find((item) => item.assetRef.resourceId === assetId);
  const ownerHref = (owner: string, id: string) =>
    `/${language ?? 'cs'}/siampark/${owner}?resourceId=${encodeURIComponent(id)}`;
  const loadSummary = () => {
    if (property === undefined) {
      return;
    }
    setPending(true);
    setSummary({});
    const requestId = Random.nextInt.pipe(Effect.map((id) => `siampark-property.summary:${id}`));
    void browserRuntime.runPromise(
      Effect.all(
        {
          agreements: requestId.pipe(
            Effect.flatMap((id) => readAgreements({}, id)),
            Effect.result,
          ),
          finance: requestId.pipe(
            Effect.flatMap((id) => readFinance({ propertyId: property.propertyRef.resourceId }, id)),
            Effect.result,
          ),
          occupancy: requestId.pipe(
            Effect.flatMap((id) => readOccupancy({}, id)),
            Effect.result,
          ),
          work: requestId.pipe(
            Effect.flatMap((id) => readWork({}, id)),
            Effect.result,
          ),
        },
        { concurrency: 1 },
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            setSummary({
              agreements: Result.getOrUndefined(result.agreements),
              finance: Result.getOrUndefined(result.finance),
              occupancy: Result.getOrUndefined(result.occupancy),
              work: Result.getOrUndefined(result.work),
            });
            const unavailable: string[] = [];
            if (Result.isFailure(result.agreements)) {
              unavailable.push(t(`${key}.agreementsUnavailable`));
            }
            if (Result.isFailure(result.occupancy)) {
              unavailable.push(t(`${key}.occupancyUnavailable`));
            }
            if (Result.isFailure(result.finance)) {
              unavailable.push(t(`${key}.financeUnavailable`));
            }
            if (Result.isFailure(result.work)) {
              unavailable.push(t(`${key}.tasksUnavailable`));
            }
            setSummaryMessage(unavailable.join(' · '));
            setPending(false);
          }),
        ),
      ),
    );
  };
  const referenceDate = '2026-10-05';
  const availability = (id: string) => {
    const covering =
      occupancy?.occupancies.filter(
        (item) =>
          item.unitRef.resourceId === id &&
          item.startDate <= referenceDate &&
          (item.endDate === null || referenceDate < item.endDate),
      ) ?? [];
    if (covering.some((item) => item.state === 'ACTIVE')) {
      return 'OCCUPIED';
    }
    return covering.some((item) => item.state === 'CONFIRMED') ? 'RESERVED' : 'AVAILABLE';
  };
  const money = (minor: number) =>
    (language === 'en' ? currencyFormatters.en : currencyFormatters.cs).format(minor / 100);
  const { activeOccupancies, propertyContracts, propertyDocuments, propertyTasks } = projectPropertyRelatedRecords({
    agreements,
    assets,
    occupancy,
    property,
    units,
    work,
  });
  const unitName = (id: string | undefined) => units.find((item) => item.unitRef.resourceId === id)?.name ?? '—';
  const relatedSections = [
    {
      enabled: occupancy !== undefined,
      items: activeOccupancies.map((item) => ({
        href: ownerHref('occupancy', item.occupancyRef.resourceId),
        label: [
          unitName(item.unitRef.resourceId),
          t(`${key}.occupancyRecord`, { end: item.endDate ?? '—', start: item.startDate }),
          t(`${key}.occupancyStates.${item.state}`),
        ].join(' · '),
      })),
      title: t(`${key}.occupancies`),
    },
    {
      enabled: agreements !== undefined,
      items: propertyContracts.map((item) => ({
        href: ownerHref('agreements', item.contractRef.resourceId),
        label: [
          unitName(item.unitRef?.resourceId),
          t(`${key}.agreementRecord`, { end: item.endDate ?? '—', start: item.startDate }),
          t(`${key}.agreementStates.${item.lifecycleState}`),
        ].join(' · '),
      })),
      title: t(`${key}.agreements`),
    },
    {
      enabled: agreements !== undefined,
      items: propertyDocuments.map((item) => ({
        href: ownerHref('agreements', item.contractRef?.resourceId ?? ''),
        label: [item.title, item.fileName ?? '—', item.signedDocumentReference ?? '—'].join(' · '),
      })),
      title: t(`${key}.documents`),
    },
    {
      enabled: work !== undefined,
      items: propertyTasks.map((item) => ({ href: ownerHref('work', item.ref.resourceId), label: item.title })),
      title: t(`${key}.tasks`),
    },
  ];
  const tables = [
    {
      kind: 'properties',
      rows: (records?.properties ?? []).map((item) => ({
        code: item.code,
        id: item.propertyRef.resourceId,
        name: item.name,
        property: item,
        state: item.lifecycleState,
      })),
      select: selectProperty,
    },
    {
      kind: 'units',
      rows: units.map((item) => ({
        code: item.code,
        id: item.unitRef.resourceId,
        name: item.name,
        property: null,
        state: item.lifecycleState,
      })),
      select: setUnitId,
    },
    {
      kind: 'assets',
      rows: assets.map((item) => ({
        code: item.code,
        id: item.assetRef.resourceId,
        name: item.name,
        property: null,
        state: item.lifecycleState,
      })),
      select: setAssetId,
    },
  ];
  return {
    agreements,
    asset,
    assets,
    availability,
    finance,
    key,
    loadSummary,
    message,
    money,
    occupancy,
    ownerHref,
    pending,
    property,
    records,
    refresh,
    relatedSections,
    selectProperty,
    setAssetId,
    setUnitId,
    summaryMessage,
    t,
    tables,
    unit,
    units,
    work,
  };
};
const secondaryTextClass = 'siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)';
const detailCardClass =
  'siamparkproperty:min-w-0 siamparkproperty:space-y-4 siamparkproperty:rounded-lg siamparkproperty:border siamparkproperty:border-(--color-border-muted) siamparkproperty:bg-(--color-surface) siamparkproperty:p-5';
const relatedCardClass =
  'siamparkproperty:min-w-0 siamparkproperty:space-y-3 siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface-subtle) siamparkproperty:p-4';
const detailHeadingClass = 'siamparkproperty:text-sm siamparkproperty:font-semibold';
const tableWrapperClass =
  'siamparkproperty:min-w-0 siamparkproperty:overflow-x-auto siamparkproperty:rounded-lg siamparkproperty:bg-(--color-surface)';
const messageClass = 'siamparkproperty:block siamparkproperty:text-sm siamparkproperty:text-(--color-fg-secondary)';
const RecordsPageContent = () => {
  const model = usePropertyRecords();
  const editor = usePropertyEditor(model.records, model.refresh);
  const refreshOnMount = useEffectEvent(model.refresh);
  useEffect(() => {
    refreshOnMount();
  }, []);
  const { asset, key, relatedSections, t, unit } = model;
  const handleRefresh = model.refresh;
  const handleLoadSummary = model.loadSummary;
  const availabilityLabel = (id: string, lifecycle: string) => {
    if (model.occupancy === undefined) {
      return t(`${key}.summaryNotLoaded`);
    }
    if (lifecycle === 'ACTIVE') {
      return t(`${key}.availability.${model.availability(id)}`);
    }
    return t(`${key}.outOfService`);
  };
  const handleCancelEditor = editor.cancel;
  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby="records-heading"
        className="siamparkproperty:w-full siamparkproperty:min-w-0 siamparkproperty:max-w-none siamparkproperty:space-y-6 siamparkproperty:p-0 siamparkproperty:text-(--color-page-fg)"
      >
        <header className="siamparkproperty:flex siamparkproperty:flex-wrap siamparkproperty:items-start siamparkproperty:justify-between siamparkproperty:gap-4 siamparkproperty:border-b siamparkproperty:border-(--color-border-muted) siamparkproperty:pb-5">
          <div className="siamparkproperty:min-w-0 siamparkproperty:space-y-2">
            <h1
              className="siamparkproperty:text-3xl siamparkproperty:font-semibold siamparkproperty:tracking-tight"
              id="records-heading"
            >
              {t(`${key}.title`)}
            </h1>
            <p className={secondaryTextClass}>{t(`${key}.description`)}</p>
          </div>
          <Button disabled={model.pending || editor.busy} onClick={handleRefresh} size="sm" variant="warning">
            {t(`${key}.refresh`)}
          </Button>
        </header>
        <output aria-live="polite" className={messageClass}>
          {model.message}
        </output>
        {model.records !== undefined && (
          <>
            <Button disabled={editor.busy} onClick={() => editor.begin()} size="sm" variant="warning">
              {t(`${key}.editor.create`)}
            </Button>
            {editor.feedback !== undefined && (
              <output aria-live="polite" className={messageClass}>
                {t(`${key}.editor.${editor.feedback}`)}
              </output>
            )}
            {editor.draft !== undefined && (
              <form
                className={detailCardClass}
                onSubmit={(event) => {
                  event.preventDefault();
                  editor.save();
                }}
              >
                <h2 className="siamparkproperty:text-lg siamparkproperty:font-semibold">
                  {t(`${key}.editor.${editor.title}`)}
                </h2>
                {editor.fields.map((field) => (
                  <FormInput
                    disabled={editor.busy || (field === 'code' && editor.draft?.property !== undefined)}
                    id={`property-${field}`}
                    key={field}
                    label={t(`${key}.editor.${field}`)}
                    onChange={(event) => editor.change(field, event.target.value)}
                    required={field !== 'note'}
                    value={editor.draft?.[field] ?? ''}
                  />
                ))}
                <div className="siamparkproperty:flex siamparkproperty:gap-3">
                  <Button disabled={editor.busy} type="submit" variant="warning">
                    {t(`${key}.editor.save`)}
                  </Button>
                  <Button disabled={editor.busy} onClick={handleCancelEditor} theme="outlined" variant="secondary">
                    {t(`${key}.editor.cancel`)}
                  </Button>
                </div>
              </form>
            )}
            {model.tables.flatMap((group) =>
              group.kind !== 'properties' && model.property === undefined
                ? []
                : [
                    <div className={tableWrapperClass} key={group.kind}>
                      <Table className="siamparkproperty:w-full" size="sm" variant="outline">
                        <Table.Caption>{t(`${key}.${group.kind}`)}</Table.Caption>
                        <Table.Header>
                          <Table.Row>
                            {['code', 'name', 'state', 'detail'].map((column) => (
                              <Table.ColumnHeader key={column}>{t(`${key}.${column}`)}</Table.ColumnHeader>
                            ))}
                          </Table.Row>
                        </Table.Header>
                        <Table.Body>
                          {group.rows.map((item) => (
                            <Table.Row key={item.id}>
                              <Table.Cell>{item.code}</Table.Cell>
                              <Table.Cell>{item.name}</Table.Cell>
                              <Table.Cell>
                                <Badge size="sm" variant={item.state === 'ACTIVE' ? 'success' : 'outline'}>
                                  {t(`${key}.states.${item.state}`)}
                                </Badge>
                                {group.kind === 'units' && <span>{availabilityLabel(item.id, item.state)}</span>}
                              </Table.Cell>
                              <Table.Cell>
                                <Button
                                  disabled={model.pending || editor.busy}
                                  onClick={() => group.select(item.id)}
                                  size="sm"
                                  theme="outlined"
                                  variant="secondary"
                                >
                                  {t(`${key}.detail`)}
                                </Button>
                                {item.property !== null && (
                                  <Button
                                    disabled={editor.busy}
                                    onClick={() => editor.begin(item.property)}
                                    size="sm"
                                    theme="outlined"
                                    variant="secondary"
                                  >
                                    {t(`${key}.editor.edit`)}
                                  </Button>
                                )}
                              </Table.Cell>
                            </Table.Row>
                          ))}
                        </Table.Body>
                      </Table>
                    </div>,
                  ],
            )}
            {model.property !== undefined && (
              <article aria-label={t(`${key}.detail`)} className={detailCardClass}>
                <h2 className="siamparkproperty:text-lg siamparkproperty:font-semibold">
                  {model.property.code} · {model.property.name}
                </h2>
                <p className={secondaryTextClass}>{model.property.address}</p>
                <p className={secondaryTextClass}>{model.property.note ?? '—'}</p>
                <Button
                  disabled={editor.busy}
                  onClick={() => {
                    if (model.property !== undefined) {
                      editor.toggleLifecycle(model.property);
                    }
                  }}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  {t(`${key}.editor.${model.property.lifecycleState === 'ACTIVE' ? 'deactivate' : 'activate'}`)}
                </Button>
                <Button
                  disabled={editor.busy}
                  onClick={() => {
                    if (model.property !== undefined) {
                      editor.beginUnit(model.property);
                    }
                  }}
                  size="sm"
                  variant="warning"
                >
                  {t(`${key}.editor.createUnit`)}
                </Button>
                <Button
                  disabled={model.pending}
                  onClick={handleLoadSummary}
                  size="sm"
                  theme="outlined"
                  variant="secondary"
                >
                  {t(`${key}.loadSummary`)}
                </Button>
                <output aria-live="polite" className={messageClass}>
                  {model.summaryMessage}
                </output>
                {model.finance !== undefined && (
                  <section aria-label={t(`${key}.financialSummary`)} className={relatedCardClass}>
                    <h3 className={detailHeadingClass}>{t(`${key}.financialSummary`)}</h3>
                    <p className={secondaryTextClass}>
                      {t(`${key}.financialValues`, {
                        cost: model.money(model.finance.indicators.costMinor),
                        outstanding: model.money(model.finance.indicators.grossOutstandingMinor),
                        revenue: model.money(model.finance.indicators.revenueMinor),
                      })}
                    </p>
                    <ul className="siamparkproperty:space-y-2 siamparkproperty:text-sm">
                      {model.finance.state.invoices.map((invoice) => (
                        <li key={invoice.ref.resourceId}>
                          <Link href={model.ownerHref('finance', invoice.ref.resourceId)}>
                            {invoice.documentNumber} · {model.money(invoice.totalMinor)}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <div className="siamparkproperty:grid siamparkproperty:gap-4 siamparkproperty:lg:grid-cols-2">
                  {relatedSections.flatMap((section) =>
                    section.enabled
                      ? [
                          <section aria-label={section.title} className={relatedCardClass} key={section.title}>
                            <h3 className={detailHeadingClass}>{section.title}</h3>
                            {section.items.length === 0 && (
                              <p className={secondaryTextClass}>{t(`${key}.emptyRelated`)}</p>
                            )}
                            <ul className="siamparkproperty:space-y-2 siamparkproperty:text-sm">
                              {section.items.map((item) => (
                                <li key={item.href}>
                                  <Link href={item.href}>{item.label}</Link>
                                </li>
                              ))}
                            </ul>
                          </section>,
                        ]
                      : [],
                  )}
                </div>
                {unit !== undefined && (
                  <aside className={relatedCardClass}>
                    <h3 className={detailHeadingClass}>
                      {unit.code} · {unit.name}
                    </h3>
                    <p className={secondaryTextClass}>
                      {t(`${key}.kind`)}: {unit.unitKind ?? '—'} · {t(`${key}.capacity`)}: {unit.capacity ?? '—'}
                    </p>
                    <p className={secondaryTextClass}>{unit.note ?? '—'}</p>
                    {model.occupancy !== undefined && (
                      <ul className="siamparkproperty:space-y-2 siamparkproperty:text-sm">
                        {model.occupancy.occupancies.flatMap((item) =>
                          item.unitRef.resourceId === unit.unitRef.resourceId
                            ? [
                                <li key={item.occupancyRef.resourceId}>
                                  <Link href={model.ownerHref('occupancy', item.occupancyRef.resourceId)}>
                                    {t(`${key}.occupancyRecord`, {
                                      end: item.endDate ?? '—',
                                      start: item.startDate,
                                    })}
                                  </Link>
                                </li>,
                              ]
                            : [],
                        )}
                      </ul>
                    )}
                  </aside>
                )}
                {asset !== undefined && (
                  <aside className={relatedCardClass}>
                    <h3 className={detailHeadingClass}>
                      {asset.code} · {asset.name}
                    </h3>
                    <p className={secondaryTextClass}>
                      {asset.category} · {asset.serialNumber ?? '—'}
                    </p>
                    {model.work !== undefined && (
                      <ul className="siamparkproperty:space-y-2 siamparkproperty:text-sm">
                        {model.work.items.flatMap((task) =>
                          task.contextRefs.some(
                            (ref) =>
                              ref.moduleId === asset.assetRef.moduleId &&
                              ref.resourceType === asset.assetRef.resourceType &&
                              ref.tenantId === asset.assetRef.tenantId &&
                              ref.resourceId === asset.assetRef.resourceId,
                          )
                            ? [
                                <li key={task.ref.resourceId}>
                                  <Link href={model.ownerHref('work', task.ref.resourceId)}>{task.title}</Link>
                                </li>,
                              ]
                            : [],
                        )}
                      </ul>
                    )}
                    <p className={secondaryTextClass}>
                      {t(`${key}.lastService`)}: {asset.lastServiceAt ?? '—'} · {t(`${key}.nextService`)}:{' '}
                      {asset.nextServiceAt ?? '—'}
                    </p>
                  </aside>
                )}
              </article>
            )}
          </>
        )}
      </section>
    </>
  );
};

export const RecordsPage = () => {
  const location = useRouterState({ select: (state) => state.location.href });
  return (
    <FederatedI18nBoundary
      defaultNamespace="siampark-property"
      fallbackLanguage="en"
      resources={siamparkPropertyI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={location} />
    </FederatedI18nBoundary>
  );
};
export default RecordsPage;
