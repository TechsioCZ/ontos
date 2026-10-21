import { PropertyEquipment, RecordDiscussion } from '@app/facility-operations/ui/record-discussion';
import { UnitRefSchema } from '../../../../../shared/resources/unit.ts';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Link } from '@techsio/ui-kit/atoms/link';
import { useNavigate, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { executeRecords as readAgreements } from '@app/legal-agreements/clients/records';
import { executeRecords as readOccupancy } from '@app/property-leasing/clients/records';
import { executeRecords as readFinance } from '@app/finance-billing/clients/records';
import { executeRecords as readWork } from '@app/work-tasks/clients/records';
import { DateTime, Effect, Match, Option, Random, Result, Schema } from 'effect';
import { useEffect, useEffectEvent, useState } from 'react';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { usePropertyEditor } from './use-property-editor.ts';
import './property-editor.css';
import { UnitStory, pragueToday } from './unit-story.tsx';
import { executeRecords } from '../../../../api/records-client';
import type { RecordsResponse } from '../../../../../shared/apis/records';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import csResource from '../../../../../locales/cs/property-portfolio.json';
import enResource from '../../../../../locales/en/property-portfolio.json';
import '../../../index.css';

const currencyFormatters = {
  cs: new Intl.NumberFormat('cs-CZ', { currency: 'CZK', style: 'currency' }),
  en: new Intl.NumberFormat('en-GB', { currency: 'CZK', style: 'currency' }),
};
const searchSchema = Schema.Struct({
  resourceId: Schema.optional(UnitRefSchema.fields.resourceId.check(Schema.isUUID())),
});
const propertyPortfolioI18nResources = {
  cs: { 'property-portfolio': csResource },
  en: { 'property-portfolio': enResource },
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
  const key = 'property-portfolio.pages.records';
  const [records, setRecords] = useState<RecordsResponse>();
  const [selection, setSelection] = useState({ assetId: '', propertyId: '', unitId: '' });
  const { assetId, propertyId, unitId } = selection;
  const navigate = useNavigate();
  const selectResource = (id: string) => {
    void navigate({ replace: true, search: { resourceId: id }, to: '.' });
  };
  const setUnitId = (selectedUnitId: string) => {
    setSelection((current) => ({ ...current, assetId: '', unitId: selectedUnitId }));
    selectResource(selectedUnitId || propertyId);
  };
  const setAssetId = (selectedAssetId: string) => {
    setSelection((current) => ({ ...current, assetId: selectedAssetId, unitId: '' }));
    selectResource(selectedAssetId || propertyId);
  };
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
    selectResource(selectedPropertyId);
    setSelection({ assetId: '', propertyId: selectedPropertyId, unitId: '' });
    setSummary({});
    setSummaryMessage('');
  };
  const refresh = () => {
    setPending(true);
    void browserRuntime.runPromise(
      Random.nextInt.pipe(
        Effect.flatMap((id) => executeRecords({ includeArchived: true }, `property-records:${id}`)),
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
            setSelection((current) => ({
              assetId: selectedAsset?.assetRef.resourceId ?? (resourceId === undefined ? current.assetId : ''),
              propertyId:
                selectedProperty?.propertyRef.resourceId ??
                selectedUnit?.propertyRef.resourceId ??
                selectedAsset?.propertyRef.resourceId ??
                (resourceId === undefined &&
                result.properties.some((item) => item.propertyRef.resourceId === current.propertyId)
                  ? current.propertyId
                  : ''),
              unitId: selectedUnit?.unitRef.resourceId ?? (resourceId === undefined ? current.unitId : ''),
            }));
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
    `/${language ?? 'cs'}/${owner}?resourceId=${encodeURIComponent(id)}`;
  const loadSummary = () => {
    if (property === undefined) {
      return;
    }
    setPending(true);
    setSummary({});
    const requestId = Random.nextInt.pipe(Effect.map((id) => `property-portfolio.summary:${id}`));
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
        { concurrency: 4 },
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
  const referenceDate = pragueToday();
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
        href: ownerHref('najmy', item.occupancyRef.resourceId),
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
        href: ownerHref('smlouvy', item.contractRef.resourceId),
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
        href: ownerHref('smlouvy', item.contractRef?.resourceId ?? ''),
        label: [item.title, item.fileName ?? '—', item.signedDocumentReference ?? '—'].join(' · '),
      })),
      title: t(`${key}.documents`),
    },
    {
      enabled: work !== undefined,
      items: propertyTasks.map((item) => ({ href: ownerHref('ukoly', item.ref.resourceId), label: item.title })),
      title: t(`${key}.tasks`),
    },
  ];
  const tables = [
    {
      kind: 'properties',
      rows: (records?.properties ?? []).map((item) => ({
        archived: item.archive !== undefined,
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
        archived: item.archive !== undefined || property?.archive !== undefined,
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
        archived: property?.archive !== undefined,
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
    language: language ?? 'cs',
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
const secondaryTextClass = 'propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)';
const detailCardClass =
  'ontos-card rounded-lg border border-border-primary/60 bg-base [&_.ontos-card]:border-0 [&_.ontos-card]:bg-transparent [&_.ontos-card]:p-0 propertyportfolio:min-w-0 propertyportfolio:space-y-4 propertyportfolio:p-5';
const relatedCardClass =
  'ontos-tile rounded-lg bg-surface [&_.ontos-tile]:bg-base propertyportfolio:min-w-0 propertyportfolio:space-y-3 propertyportfolio:p-4';
const detailHeadingClass = 'propertyportfolio:text-sm propertyportfolio:font-semibold';
const tableWrapperClass =
  'propertyportfolio:min-w-0 propertyportfolio:overflow-x-auto';
const messageClass = 'propertyportfolio:block propertyportfolio:text-sm propertyportfolio:text-(--color-fg-secondary)';
const archivedAtFormat = new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeZone: 'Europe/Prague' });
const formatArchivedAt = (value: string) => archivedAtFormat.format(DateTime.toEpochMillis(DateTime.makeUnsafe(value)));
const RecordsPageContent = () => {
  const model = usePropertyRecords();
  const editor = usePropertyEditor(model.records, model.refresh);
  const refreshOnMount = useEffectEvent(model.refresh);
  useEffect(() => {
    refreshOnMount();
  }, []);
  // Building detail shows its leases, contracts and tasks at once; the explicit button stays for a manual reload.
  const loadSummaryOnSelect = useEffectEvent(model.loadSummary);
  const selectedProperty = model.property;
  useEffect(() => {
    if (selectedProperty !== undefined) {
      loadSummaryOnSelect();
    }
  }, [selectedProperty]);
  const { asset, key, relatedSections, t, unit } = model;
  const handleRefresh = model.refresh;
  const handleLoadSummary = model.loadSummary;
  // A unit is offered only while both the unit and its building are in operation; retired or archived units
  // and units of a building out of operation never advertise availability.
  const leasable = (lifecycle: string) =>
    lifecycle === 'ACTIVE' && model.property?.lifecycleState === 'ACTIVE' && model.property.archive === undefined;
  const availabilityLabel = (id: string, lifecycle: string) => {
    if (lifecycle === 'RETIRED') {
      return 'Vyřazena – nenabízí se k pronájmu';
    }
    if (lifecycle !== 'ACTIVE') {
      return t(`${key}.outOfService`);
    }
    if (!leasable(lifecycle)) {
      return 'Budova není v provozu – nenabízí se k pronájmu';
    }
    if (model.occupancy === undefined) {
      return t(`${key}.summaryNotLoaded`);
    }
    return t(`${key}.availability.${model.availability(id)}`);
  };
  const archiveReason = (label: string) =>
    globalThis.prompt(
      `Archivovat ${label}? Záznam zmizí ze všech seznamů a výběrů; data i historie zůstanou a lze jej obnovit. Důvod archivace:`,
      'Testovací záznam z ověřování',
    );
  const handleCancelEditor = editor.cancel;
  const [showClosed, setShowClosed] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const unitArchive = unit?.archive ?? model.property?.archive;
  const archivedCount = model.records?.properties.filter((item) => item.archive !== undefined).length ?? 0;
  return (
    <>
      <UltramodernRouteHead />
      <section
        aria-labelledby="records-heading"
        className="propertyportfolio:w-full propertyportfolio:min-w-0 propertyportfolio:max-w-none propertyportfolio:space-y-6 propertyportfolio:p-0 propertyportfolio:text-(--color-page-fg)"
      >
        <header className="propertyportfolio:flex propertyportfolio:flex-wrap propertyportfolio:items-start propertyportfolio:justify-between propertyportfolio:gap-4 propertyportfolio:pb-5">
          <div className="propertyportfolio:min-w-0 propertyportfolio:space-y-2">
            <h1
              className="propertyportfolio:text-3xl propertyportfolio:font-semibold propertyportfolio:tracking-tight"
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
                className={`${detailCardClass} sp-property-editor`}
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  editor.save();
                }}
              >
                <h2 className="propertyportfolio:text-lg propertyportfolio:font-semibold">
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
                    {...(editor.errors[field] === undefined
                      ? {}
                      : { helpText: editor.errors[field], validateStatus: 'error' as const })}
                  />
                ))}
                {editor.draft.unitFor === undefined && (
                  <label className="sp-property-state">
                    {t(`${key}.state`)}
                    <select
                      aria-label={t(`${key}.state`)}
                      value={editor.draft.lifecycleState}
                      onChange={(event) => editor.changeLifecycle(event.target.value)}
                    >
                      {(['PLANNED', 'ACTIVE', 'INACTIVE', 'DISPOSED'] as const).map((state) => (
                        <option key={state} value={state}>
                          {t(`${key}.states.${state}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="sp-property-editor-actions propertyportfolio:flex propertyportfolio:gap-3">
                  <Button disabled={editor.busy} type="submit" variant="warning">
                    {t(`${key}.editor.save`)}
                  </Button>
                  <Button disabled={editor.busy} onClick={handleCancelEditor} theme="outlined" variant="secondary">
                    {t(`${key}.editor.cancel`)}
                  </Button>
                </div>
              </form>
            )}
            <label className={`${secondaryTextClass} sp-property-toggle`}>
              <input checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} type="checkbox" />{' '}
              Zobrazit i neaktivní a vyřazené nemovitosti a jednotky
            </label>
            {archivedCount > 0 && (
              <label className={`${secondaryTextClass} sp-property-toggle`}>
                <input
                  checked={showArchived}
                  onChange={(event) => setShowArchived(event.target.checked)}
                  type="checkbox"
                />{' '}
                Zobrazit archivované záznamy ({archivedCount})
              </label>
            )}
            {model.tables.flatMap((group) =>
              (group.kind !== 'properties' && model.property === undefined) ||
              (group.kind === 'assets' && group.rows.length === 0)
                ? []
                : [
                    <div className={tableWrapperClass} key={group.kind}>
                      <Table className="propertyportfolio:w-full" size="sm" variant="outline">
                        <Table.Caption>{t(`${key}.${group.kind}`)}</Table.Caption>
                        <Table.Header>
                          <Table.Row>
                            {['code', 'name', 'state', 'detail'].map((column) => (
                              <Table.ColumnHeader key={column}>{t(`${key}.${column}`)}</Table.ColumnHeader>
                            ))}
                          </Table.Row>
                        </Table.Header>
                        <Table.Body>
                          {group.rows
                            .filter(
                              (item) =>
                                (showArchived || !item.archived) &&
                                (showClosed ||
                                group.kind === 'assets' ||
                                ['ACTIVE', 'PLANNED', 'OUT_OF_SERVICE'].includes(item.state) ||
                                item.id === model.property?.propertyRef.resourceId ||
                                item.id === unit?.unitRef.resourceId),
                            )
                            .map((item) => (
                              <Table.Row key={item.id}>
                                <Table.Cell>{item.code}</Table.Cell>
                                <Table.Cell>{item.name}</Table.Cell>
                                <Table.Cell>
                                  <span className="propertyportfolio:inline-flex propertyportfolio:flex-wrap propertyportfolio:items-center propertyportfolio:gap-2">
                                    <Badge size="sm" variant={item.state === 'ACTIVE' ? 'success' : 'outline'}>
                                      {t(`${key}.states.${item.state}`)}
                                    </Badge>
                                    {item.archived && (
                                      <Badge size="sm" variant="secondary">
                                        Archivováno
                                      </Badge>
                                    )}
                                    {group.kind === 'units' && (
                                      <span className={secondaryTextClass}>
                                        {availabilityLabel(item.id, item.state)}
                                      </span>
                                    )}
                                  </span>
                                </Table.Cell>
                                <Table.Cell>
                                  <div className="sp-property-row-actions">
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
                                  </div>
                                </Table.Cell>
                              </Table.Row>
                            ))}
                        </Table.Body>
                      </Table>
                    </div>,
                  ],
            )}
            {model.property !== undefined && (
              <PropertyEquipment
                key={`${model.property.propertyRef.resourceId}:${unit?.unitRef.resourceId ?? ''}`}
                language={model.language}
                propertyId={model.property.propertyRef.resourceId}
                unitId={unit?.unitRef.resourceId}
              />
            )}
            {model.property !== undefined && (
              <article aria-label={t(`${key}.detail`)} className={detailCardClass}>
                <h2 className="propertyportfolio:text-lg propertyportfolio:font-semibold">
                  {model.property.code} · {model.property.name}
                </h2>
                <p className={secondaryTextClass}>{model.property.address}</p>
                <p className={secondaryTextClass}>{model.property.note ?? '—'}</p>
                {model.property.archive !== undefined && (
                  <p className={secondaryTextClass} role="status">
                    Archivováno {formatArchivedAt(model.property.archive.archivedAt)} · {model.property.archive.reason}.
                    Záznam se nezobrazuje v seznamech ani výběrech ostatních agend.
                  </p>
                )}
                <div className="propertyportfolio:flex propertyportfolio:flex-wrap propertyportfolio:gap-2">
                  {model.property.archive === undefined ? (
                    <>
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
                  {model.property.lifecycleState !== 'ACTIVE' && (
                    <Button
                      disabled={editor.busy}
                      onClick={() => {
                        const property = model.property;
                        const reason = property === undefined ? null : archiveReason(`nemovitost ${property.code}`);
                        if (property !== undefined && reason !== null && reason.trim() !== '')
                          editor.archiveProperty(property, reason.trim());
                      }}
                      size="sm"
                      theme="outlined"
                      variant="danger"
                    >
                      Archivovat záznam
                    </Button>
                  )}
                    </>
                  ) : (
                    <Button
                      disabled={editor.busy}
                      onClick={() => {
                        if (model.property !== undefined) editor.restoreProperty(model.property);
                      }}
                      size="sm"
                      theme="outlined"
                      variant="secondary"
                    >
                      Obnovit z archivu
                    </Button>
                  )}
                  <Button
                    disabled={model.pending}
                    onClick={handleLoadSummary}
                    size="sm"
                    theme="outlined"
                    variant="secondary"
                  >
                    {t(`${key}.loadSummary`)}
                  </Button>
                </div>
                <div className={relatedCardClass}>
                  <p className={secondaryTextClass}>
                    {t(`${key}.editor.propertyType`)}: {model.property.propertyType ?? 'Neuvedeno'}
                  </p>
                  <p className={secondaryTextClass}>
                    {t(`${key}.editor.responsiblePerson`)}: {model.property.responsiblePerson ?? 'Neuvedeno'}
                  </p>
                  <p className={secondaryTextClass}>
                    {t(`${key}.editor.note`)}: {model.property.note ?? 'Neuvedeno'}
                  </p>
                </div>
                <output aria-live="polite" className={messageClass}>
                  {model.summaryMessage}
                </output>
                {unit === undefined && model.property !== undefined && (
                  <RecordDiscussion
                    subject={{
                      kind: 'property',
                      id: model.property.propertyRef.resourceId,
                      label: model.property.name,
                    }}
                  />
                )}
                {unit !== undefined && (
                  <aside aria-label={`${unit.code} · ${unit.name}`} className={relatedCardClass} id="unit-detail">
                    <h3 className={detailHeadingClass}>
                      {unit.code} · {unit.name}
                    </h3>
                    <p className={secondaryTextClass}>
                      {t(`${key}.kind`)}: {unit.unitKind ?? '—'} · {t(`${key}.capacity`)}: {unit.capacity ?? '—'} ·{' '}
                      {availabilityLabel(unit.unitRef.resourceId, unit.lifecycleState)}
                    </p>
                    {unit.note !== null && <p className={secondaryTextClass}>{unit.note}</p>}
                    {model.property?.lifecycleState !== 'ACTIVE' && unit.lifecycleState === 'ACTIVE' && (
                      <p className={secondaryTextClass}>
                        Budova není aktivní, jednotku proto nelze pronajmout ani rezervovat.
                      </p>
                    )}
                    {unit.lifecycleState === 'RETIRED' && (
                      <p className={secondaryTextClass}>
                        Jednotka je vyřazená: nenabízí se k pronájmu ani rezervaci, historie nájmů a smluv zůstává.
                      </p>
                    )}
                    {unitArchive !== undefined && (
                      <p className={secondaryTextClass} role="status">
                        Archivováno {formatArchivedAt(unitArchive.archivedAt)} · {unitArchive.reason}.
                      </p>
                    )}
                    <div className="propertyportfolio:flex propertyportfolio:flex-wrap propertyportfolio:gap-2">
                      {unit.lifecycleState === 'RETIRED' && unitArchive === undefined && (
                        <Button
                          disabled={editor.busy}
                          onClick={() => {
                            const reason = archiveReason(`jednotku ${unit.code}`);
                            if (reason !== null && reason.trim() !== '') editor.archiveUnit(unit, reason.trim());
                          }}
                          size="sm"
                          theme="outlined"
                          variant="danger"
                        >
                          Archivovat jednotku
                        </Button>
                      )}
                      {unit.archive !== undefined && model.property?.archive === undefined && (
                        <Button
                          disabled={editor.busy}
                          onClick={() => editor.restoreUnit(unit)}
                          size="sm"
                          theme="outlined"
                          variant="secondary"
                        >
                          Obnovit z archivu
                        </Button>
                      )}
                      {unitArchive === undefined && unit.lifecycleState === 'ACTIVE' && (
                        <Button
                          disabled={editor.busy}
                          onClick={() => editor.changeUnitLifecycle(unit, 'OUT_OF_SERVICE')}
                          size="sm"
                          theme="outlined"
                          variant="secondary"
                        >
                          Dočasně mimo provoz
                        </Button>
                      )}
                      {unitArchive === undefined &&
                        unit.lifecycleState === 'OUT_OF_SERVICE' &&
                        model.property?.lifecycleState !== 'DISPOSED' && (
                        <Button
                          disabled={editor.busy}
                          onClick={() => editor.changeUnitLifecycle(unit, 'ACTIVE')}
                          size="sm"
                          theme="outlined"
                          variant="secondary"
                        >
                          Vrátit do provozu
                        </Button>
                      )}
                      {unitArchive === undefined && unit.lifecycleState !== 'RETIRED' && (
                        <Button
                          disabled={editor.busy}
                          onClick={() => {
                            if (
                              globalThis.confirm(
                                `Vyřadit jednotku ${unit.code}? Jednotka se přestane nabízet k pronájmu, historie nájmů a smluv zůstane zachována.`,
                              )
                            )
                              editor.changeUnitLifecycle(unit, 'RETIRED');
                          }}
                          size="sm"
                          theme="outlined"
                          variant="danger"
                        >
                          Vyřadit jednotku
                        </Button>
                      )}
                    </div>
                    <UnitStory
                      agreements={model.agreements}
                      leaseBlock={
                        unitArchive !== undefined || unit.lifecycleState === 'RETIRED'
                          ? 'retired'
                          : unit.lifecycleState !== 'ACTIVE'
                            ? 'outOfService'
                            : leasable(unit.lifecycleState)
                              ? undefined
                              : 'building'
                      }
                      language={model.language}
                      occupancy={model.occupancy}
                      t={t}
                      tasks={model.work?.items}
                      unit={unit}
                    />
                    <RecordDiscussion
                      subject={{ kind: 'unit', id: unit.unitRef.resourceId, label: `${unit.code} · ${unit.name}` }}
                    />
                  </aside>
                )}
                {model.finance !== undefined && (
                  <section aria-label={t(`${key}.financialSummary`)} className={relatedCardClass}>
                    <h3 className={detailHeadingClass}>{t(`${key}.financialSummary`)}</h3>
                    <p className={secondaryTextClass}>
                      {model.finance.state.invoices.length === 0
                        ? 'Bez dat – k této nemovitosti zatím nejsou evidované žádné faktury ani platby.'
                        : t(`${key}.financialValues`, {
                            cost: model.money(model.finance.indicators.costMinor),
                            outstanding: model.money(model.finance.indicators.grossOutstandingMinor),
                            revenue: model.money(model.finance.indicators.revenueMinor),
                          })}
                    </p>
                    <ul className="propertyportfolio:space-y-2 propertyportfolio:text-sm">
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
                <div className="propertyportfolio:grid propertyportfolio:gap-4 propertyportfolio:lg:grid-cols-2">
                  {relatedSections.flatMap((section) =>
                    section.enabled
                      ? [
                          <section aria-label={section.title} className={relatedCardClass} key={section.title}>
                            <h3 className={detailHeadingClass}>{section.title}</h3>
                            {section.items.length === 0 && (
                              <p className={secondaryTextClass}>{t(`${key}.emptyRelated`)}</p>
                            )}
                            <ul className="propertyportfolio:space-y-2 propertyportfolio:text-sm">
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
                {asset !== undefined && (
                  <aside className={relatedCardClass}>
                    <h3 className={detailHeadingClass}>
                      {asset.code} · {asset.name}
                    </h3>
                    <p className={secondaryTextClass}>
                      {asset.category} · {asset.serialNumber ?? '—'}
                    </p>
                    {model.work !== undefined && (
                      <ul className="propertyportfolio:space-y-2 propertyportfolio:text-sm">
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
                                  <Link href={model.ownerHref('ukoly', task.ref.resourceId)}>{task.title}</Link>
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
      defaultNamespace="property-portfolio"
      fallbackLanguage="en"
      resources={propertyPortfolioI18nResources}
      supportedLanguages={['en', 'cs']}
    >
      <RecordsPageContent key={location} />
    </FederatedI18nBoundary>
  );
};
export default RecordsPage;
