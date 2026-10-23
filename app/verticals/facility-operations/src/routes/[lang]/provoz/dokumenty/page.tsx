// Facility operations — Dokumenty a smlouvy (S12) + Interní zprávy (S14). OWNED BY THE `documents` LANE (ops-documents).
// Data: useAgendaRecords(['documents']); commands: shared/commands/documents.ts; files via FileUpload + records read.
import { EmptyState, PageHeader, SectionCard, StatCard, StatRow, foldSearchText } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { DateTime } from 'effect';
import { useEffect, useState } from 'react';
import type { DocumentRecord, SubjectRef } from '../../../../../shared/domain/documents.ts';
import { documentLinks } from '../../../../../shared/domain/documents.ts';
import { AgendaFrame, AgendaGate } from '../../../../ui/agenda-frame.tsx';
import { CommentThread } from '../../../../ui/comment-thread.tsx';
import {
  CategoryBadge,
  documentCategories,
  FileTypeIcon,
  formatBytes,
  formatIsoDate,
  formatWhen,
  SubjectChip,
  todayInPrague,
  useCategoryLabel,
  usePrincipalLabel,
} from '../../../../ui/documents-kit.tsx';
import { preloadAgendaRecords, useAgendaRecords } from '../../../../ui/use-agenda.ts';
import { exportCsv } from '../../../../ui/ops-agenda/ui-bits.tsx';
import { LinkedDocuments } from '../../../../ui/linked-documents.tsx';
import { useTaskOptions } from '../../../../ui/task-options.ts';
import { FinanceFilesList, financeFileText, financeInvoiceLabel, useFinanceFiles } from '../../../../ui/finance-files.tsx';
import type { FinanceFileRow } from '../../../../ui/finance-files.tsx';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { DocumentDetailPanel } from './document-detail.tsx';
import { DocumentFormPanel } from './document-form.tsx';
import './documents.css';
import type { DocumentFormMode } from './document-form.tsx';
import {
  ContractStatusBadge,
  contractRegister,
  deadlineVariant,
  isContractDocument,
  matchesFilter,
  upcomingDeadlines,
} from './documents-model.tsx';

const k = 'facility-operations.documents';
const ALL = '__all__';
const channels = ['provoz', 'vedeni', 'technika'] as const;
type Tab = 'all' | 'contracts' | 'deadlines' | 'messages';
const tabs: readonly Tab[] = ['all', 'contracts', 'deadlines', 'messages'];

const LinksCell = ({ document }: { readonly document: DocumentRecord }) => {
  const links = documentLinks(document);
  if (links.length === 0) {
    return <span className="text-fg-secondary text-xs">—</span>;
  }
  return (
    <span className="flex flex-wrap gap-50">
      {links.slice(0, 2).map((link) => (
        <SubjectChip key={`${link.kind}:${link.id}`} subject={link} />
      ))}
      {links.length > 2 && <span className="self-center text-fg-secondary text-xs">+{links.length - 2}</span>}
    </span>
  );
};

const DocumentsView = () => {
  const { language, t } = useModernI18n();
  const lang = language?.startsWith('en') === true ? 'en' : 'cs';
  const financeFiles = useFinanceFiles();
  const categoryLabel = useCategoryLabel();
  const principalLabel = usePrincipalLabel();
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const ops = useAgendaRecords(['documents']);
  const tasks = useTaskOptions();
  const requestedTaskId = new URLSearchParams(searchStr).get('taskId');
  const taskSubject = tasks.status === 'ready' ? tasks.options.find((task) => task.id === requestedTaskId) : undefined;
  const envelope = ops.data?.agendas.documents;
  const documents = envelope?.state.documents ?? [];
  const canWrite = envelope?.canWrite === true;
  const today = todayInPrague();

  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(ALL);
  const [link, setLink] = useState(ALL);
  const [owner, setOwner] = useState(ALL);
  const [changedFrom, setChangedFrom] = useState('');
  const [changedTo, setChangedTo] = useState('');
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [form, setForm] = useState<DocumentFormMode | undefined>(undefined);
  const [channel, setChannel] = useState<(typeof channels)[number]>('provoz');

  // Deep link: /provoz/dokumenty?doc=<id> opens that document (LinkedDocuments, comment attachments).
  useEffect(() => {
    const requested = new URLSearchParams(searchStr).get('doc');
    if (requested !== null && requested !== '') {
      setOpenId(requested);
    }
  }, [searchStr]);

  const filter = { category: category === ALL ? '' : category, link: link === ALL ? '' : link, query };
  /** Owner = contract owner when stated, otherwise the person who uploaded the current version (or created it). */
  const ownerOf = (document: DocumentRecord) =>
    document.contract?.owner ?? principalLabel(document.versions.at(-1)?.uploadedBy ?? document.createdBy);
  const pragueDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' });
  /** Date of the last change (Europe/Prague business date). */
  const changedOn = (document: DocumentRecord) => pragueDay.format(DateTime.toEpochMillis(document.updatedAt));
  const financeOwnerOf = (row: FinanceFileRow) => row.file.actorLabel ?? 'Finance';
  const financeAll = financeFiles.status === 'ready' ? financeFiles.rows : [];
  const owners = [...new Set([...documents.map(ownerOf), ...financeAll.map(financeOwnerOf)])].toSorted((left, right) =>
    left.localeCompare(right, 'cs'),
  );
  const financeChangedOn = (row: FinanceFileRow) => pragueDay.format(Date.parse(row.file.uploadedAt));
  const financeLinkMatches = (row: FinanceFileRow) => {
    if (link === ALL) return true;
    const [kind, ...rest] = link.split(':');
    const id = rest.join(':');
    return kind === 'invoice'
      ? row.invoice?.ref.resourceId === id
      : kind === 'contact'
        ? row.invoice?.counterpartyRef.resourceId === id
        : false;
  };
  // Invoice files uploaded in Finance, read through with the person's own Finance permission (read-only here).
  const financeFiltered = financeAll
    .filter(() => category === ALL || category === 'invoice')
    .filter((row) => owner === ALL || financeOwnerOf(row) === owner)
    .filter(financeLinkMatches)
    .filter((row) => query.trim() === '' || foldSearchText(financeFileText(row)).includes(foldSearchText(query.trim())))
    .filter((row) => changedFrom === '' || financeChangedOn(row) >= changedFrom)
    .filter((row) => changedTo === '' || financeChangedOn(row) <= changedTo);
  const filtered = documents
    .filter((document) => matchesFilter(document, filter))
    .filter((document) => owner === ALL || ownerOf(document) === owner)
    .filter((document) => changedFrom === '' || changedOn(document) >= changedFrom)
    .filter((document) => changedTo === '' || changedOn(document) <= changedTo)
    .toSorted((left, right) => formatSortKey(right).localeCompare(formatSortKey(left)));
  const filtersActive =
    query !== '' || category !== ALL || link !== ALL || owner !== ALL || changedFrom !== '' || changedTo !== '';
  const downloadCsv = () =>
    exportCsv({
      fileName: `provoz-dokumenty-${today}.csv`,
      filter: [query, category === ALL ? '' : category, owner === ALL ? '' : owner, changedFrom, changedTo]
        .filter((part) => part !== '')
        .join(' · '),
      header: [
        t(`${k}.fields.title`),
        t(`${k}.fields.category`),
        t(`${k}.filters.owner`),
        t(`${k}.fields.links`),
        t(`${k}.fields.currentVersion`),
        t(`${k}.fields.lastChange`),
      ],
      list: 'Dokumenty a smlouvy',
      log: false,
      revision: envelope?.revision ?? 0,
      rows: [
        ...filtered.map((document) => [
          document.title,
          categoryLabel(document.category),
          ownerOf(document),
          documentLinks(document)
            .map((entry) => entry.label)
            .join(', '),
          document.versions.at(-1)?.file.name ?? '',
          changedOn(document),
        ]),
        ...financeFiltered.map((row) => [
          row.file.fileName,
          `${categoryLabel('invoice')} (Finance)`,
          financeOwnerOf(row),
          [financeInvoiceLabel(row.invoice), row.invoice?.counterpartyName ?? ''].filter((part) => part !== '').join(', '),
          row.file.fileName,
          financeChangedOn(row),
        ]),
      ],
    });
  const contractDocs = documents.filter(isContractDocument);
  const register = contractRegister(documents);
  const deadlines = upcomingDeadlines(documents, today);
  const expiringSoon = deadlines.filter((entry) => entry.kind === 'end' && entry.days >= 0 && entry.days <= 30).length;
  const activeContracts = contractDocs.filter(
    (document) => document.contract?.status === 'active' && document.amendsDocumentId === undefined,
  ).length;
  const versionCount = documents.reduce((sum, document) => sum + document.versions.length, 0);
  const linkOptions = [
    ...new Map(
      documents
        .flatMap(documentLinks)
        .filter(
          (entry) =>
            entry.kind === 'property' ||
            entry.kind === 'unit' ||
            entry.kind === 'tenant' ||
            entry.kind === 'contact' ||
            entry.kind === 'invoice' ||
            entry.kind === 'task',
        )
        .map((entry) => [`${entry.kind}:${entry.id}`, entry] as const),
    ).entries(),
  ].toSorted(([, left], [, right]) => left.label.localeCompare(right.label, 'cs'));
  const openDocument = documents.find((document) => document.id === openId);
  const original =
    openDocument?.amendsDocumentId === undefined
      ? undefined
      : documents.find((document) => document.id === openDocument.amendsDocumentId);
  const amendments =
    openDocument === undefined ? [] : documents.filter((entry) => entry.amendsDocumentId === openDocument.id);
  const openAttachment = (subject: SubjectRef) => {
    if (subject.kind === 'document') {
      setOpenId(subject.id);
    }
  };

  const columns: ColumnDef<DocumentRecord>[] = [
    {
      cell: ({ row }) => {
        const version = row.original.versions.at(-1);
        return (
          <span className="flex min-w-0 items-center gap-150">
            <FileTypeIcon mime={version?.file.mime ?? ''} name={version?.file.name ?? ''} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{row.original.title}</span>
              <span className="truncate text-fg-secondary text-xs">
                {version === undefined
                  ? t(`${k}.noFileYet`)
                  : `${version.file.name} · ${formatBytes(version.file.size)}`}
              </span>
            </span>
          </span>
        );
      },
      header: t(`${k}.fields.title`),
      id: 'title',
      meta: { width: '36%' },
    },
    {
      cell: ({ row }) => (
        <span className="flex flex-wrap items-center gap-50">
          <CategoryBadge category={row.original.category} />
          {row.original.contract !== undefined && <ContractStatusBadge status={row.original.contract.status} />}
        </span>
      ),
      header: t(`${k}.fields.category`),
      id: 'category',
      meta: { width: '14%' },
    },
    {
      cell: ({ row }) => <LinksCell document={row.original} />,
      header: t(`${k}.fields.links`),
      id: 'links',
      meta: { width: '26%' },
    },
    {
      cell: ({ row }) =>
        row.original.versions.length === 0 ? (
          <span className="text-fg-secondary text-xs">—</span>
        ) : (
          <Badge size="sm" variant="outline">
            {`v${row.original.versions.at(-1)?.version ?? 1}`}
          </Badge>
        ),
      header: t(`${k}.fields.versions`),
      id: 'versions',
      meta: { width: '8%' },
    },
    {
      cell: ({ row }) => {
        const version = row.original.versions.at(-1);
        return version === undefined ? (
          <span className="text-fg-secondary text-xs">{principalLabel(row.original.createdBy)}</span>
        ) : (
          <span className="flex flex-col">
            <span className="text-sm">{principalLabel(version.uploadedBy)}</span>
            <span className="text-fg-secondary text-xs">{formatWhen(version.uploadedAt)}</span>
          </span>
        );
      },
      header: t(`${k}.fields.uploadedBy`),
      id: 'uploaded',
      meta: { width: '16%' },
    },
  ];

  return (
    <>
      <PageHeader
        actions={
          envelope === undefined ? undefined : (
            <>
              <Button onClick={() => void downloadCsv()} size="sm" theme="borderless" variant="secondary">
                {t(`${k}.filters.exportCsv`)}
              </Button>
              {canWrite && (
                <Button onClick={() => setForm({ kind: 'create' })} size="sm" variant="primary">
                  {t(`${k}.create.title`)}
                </Button>
              )}
            </>
          )
        }
        description={t(`${k}.description`)}
        title={t(`${k}.title`)}
      />
      <AgendaGate onRetry={() => void ops.reload()} readable={envelope !== undefined} status={ops.status}>
        {taskSubject !== undefined && (
          <SectionCard title={`${t(`${k}.linked.taskTitle`)} · ${taskSubject.label}`}>
            <a
              className="text-sm underline"
              href={`/cs/ukoly?resourceId=${encodeURIComponent(taskSubject.id)}`}
            >
              {t(`${k}.linked.backToTask`)}
            </a>
            <LinkedDocuments records={ops} subject={taskSubject} />
          </SectionCard>
        )}
        {requestedTaskId !== null && taskSubject === undefined && (
          <p className="text-fg-secondary text-sm">
            {t(`${k}.create.${tasks.status === 'loading' ? 'tasksLoading' : 'tasksUnavailable'}`)}
          </p>
        )}
        <StatRow>
          <StatCard label={t(`${k}.stats.count`)} value={String(documents.length)} />
          <StatCard label={t(`${k}.stats.activeContracts`)} value={String(activeContracts)} />
          <StatCard label={t(`${k}.stats.expiring`)} value={String(expiringSoon)} />
          <StatCard label={t(`${k}.stats.versions`)} value={String(versionCount)} />
          {financeFiles.status === 'ready' && (
            <StatCard label="Soubory faktur ve Financích" value={String(financeAll.length)} />
          )}
        </StatRow>

        <div className="facility-documents-tabs">
          <Tabs
            onValueChange={(value) => setTab(tabs.find((entry) => entry === value) ?? 'all')}
            value={tab}
            variant="line"
          >
            <Tabs.List>
              {tabs.map((value) => (
                <Tabs.Trigger key={value} value={value}>
                  {t(`${k}.tabs.${value}`)}
                  {value === 'deadlines' && deadlines.length > 0 && (
                    <span className="ml-100">
                      <Badge size="sm" variant={deadlineVariant(deadlines[0]?.days ?? 90)}>
                        {String(deadlines.length)}
                      </Badge>
                    </span>
                  )}
                </Tabs.Trigger>
              ))}
              <Tabs.Indicator />
            </Tabs.List>
          </Tabs>
        </div>

        {tab === 'all' && (
          <>
            <div className="flex flex-wrap items-end gap-150">
              <Input
                aria-label={t(`${k}.filters.search`)}
                className="w-80"
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t(`${k}.filters.search`)}
                size="sm"
                type="search"
                value={query}
              />
              <div className="w-56">
                <Select
                  items={[
                    {
                      displayValue: t(`${k}.filters.allCategories`),
                      label: t(`${k}.filters.allCategories`),
                      value: ALL,
                    },
                    ...documentCategories.map((value) => ({
                      displayValue: categoryLabel(value),
                      label: categoryLabel(value),
                      value,
                    })),
                  ]}
                  label={t(`${k}.filters.category`)}
                  name="documents-category-filter"
                  onValueChange={({ value }) => setCategory(value[0] ?? ALL)}
                  size="sm"
                  value={[category]}
                />
              </div>
              <div className="w-56">
                <Select
                  items={[
                    { displayValue: t(`${k}.filters.allOwners`), label: t(`${k}.filters.allOwners`), value: ALL },
                    ...owners.map((name) => ({ displayValue: name, label: name, value: name })),
                  ]}
                  label={t(`${k}.filters.owner`)}
                  name="documents-owner-filter"
                  onValueChange={({ value }) => setOwner(value[0] ?? ALL)}
                  size="sm"
                  value={[owner]}
                />
              </div>
              <div className="w-40">
                <FormInput
                  id="documents-changed-from"
                  label={t(`${k}.filters.changedFrom`)}
                  onChange={(event) => setChangedFrom(event.target.value)}
                  size="sm"
                  type="date"
                  value={changedFrom}
                />
              </div>
              <div className="w-40">
                <FormInput
                  id="documents-changed-to"
                  label={t(`${k}.filters.changedTo`)}
                  onChange={(event) => setChangedTo(event.target.value)}
                  size="sm"
                  type="date"
                  value={changedTo}
                />
              </div>
              <div className="w-72">
                <Select
                  items={[
                    { displayValue: t(`${k}.filters.allLinks`), label: t(`${k}.filters.allLinks`), value: ALL },
                    ...linkOptions.map(([value, entry]) => ({ displayValue: entry.label, label: entry.label, value })),
                  ]}
                  label={t(`${k}.filters.link`)}
                  name="documents-link-filter"
                  onValueChange={({ value }) => setLink(value[0] ?? ALL)}
                  size="sm"
                  value={[link]}
                />
              </div>
              {filtersActive && (
                <Button
                  onClick={() => {
                    setQuery('');
                    setCategory(ALL);
                    setLink(ALL);
                    setOwner(ALL);
                    setChangedFrom('');
                    setChangedTo('');
                  }}
                  size="sm"
                  theme="borderless"
                  variant="secondary"
                >
                  {t(`${k}.filters.clear`)}
                </Button>
              )}
            </div>
            <div className="facility-documents-desktop">
              <DataTable
                tableLayout="fixed"
                size="sm"
                columns={columns}
                data={filtered}
                getRowId={(row) => row.id}
                getRowLabel={(row) => row.original.title}
                loading={false}
                onRowClick={(row) => setOpenId(row.original.id)}
                translations={{
                  emptyDescription: filtersActive
                    ? t(`${k}.filters.noMatch`)
                    : t('facility-operations.common.states.emptyDescription'),
                  emptyTitle: t('facility-operations.common.states.emptyTitle'),
                }}
              />
            </div>
            <div className="facility-documents-mobile">
              {filtered.length === 0 && (
                <EmptyState
                  title={t('facility-operations.common.states.emptyTitle')}
                  description={t(`${k}.filters.noMatch`)}
                />
              )}
              {filtered.map((document) => {
                const version = document.versions.at(-1);
                return (
                  <button
                    className="facility-documents-card"
                    key={document.id}
                    onClick={() => setOpenId(document.id)}
                    type="button"
                  >
                    <FileTypeIcon mime={version?.file.mime ?? ''} name={version?.file.name ?? ''} />
                    <span className="flex min-w-0 flex-1 flex-col gap-100">
                      <span className="break-words font-semibold text-sm">{document.title}</span>
                      <span className="flex flex-wrap items-center gap-50">
                        <CategoryBadge category={document.category} />
                        {version !== undefined && <Badge size="sm" variant="outline">{`v${version.version}`}</Badge>}
                      </span>
                      <span className="text-fg-secondary text-xs">
                        {version === undefined
                          ? t(`${k}.noFileYet`)
                          : `${principalLabel(version.uploadedBy)} · ${formatWhen(version.uploadedAt)} · ${formatBytes(version.file.size)}`}
                      </span>
                      <LinksCell document={document} />
                    </span>
                  </button>
                );
              })}
            </div>
            {financeFiles.status !== 'forbidden' && (
              <SectionCard title="Soubory faktur z Financí">
                <p className="-mt-100 text-fg-secondary text-sm">
                  Doklady a přílohy nahrané k fakturám ve Financích. Zobrazují se jen ke čtení podle vašeho oprávnění
                  ve Financích; nahrávají a mění se u faktury.
                </p>
                {financeFiles.status === 'loading' && (
                  <p className="text-fg-secondary text-sm">{t('facility-operations.common.loading')}</p>
                )}
                {financeFiles.status === 'unavailable' && (
                  <p className="text-fg-secondary text-sm">Soubory z Financí jsou teď nedostupné. Zkuste stránku obnovit.</p>
                )}
                {financeFiles.status === 'ready' &&
                  (financeFiltered.length === 0 ? (
                    <p className="text-fg-secondary text-sm">
                      {financeAll.length === 0 ? 'Ve Financích zatím nejsou nahrané žádné soubory.' : t(`${k}.filters.noMatch`)}
                    </p>
                  ) : (
                    <FinanceFilesList language={lang} rows={financeFiltered} />
                  ))}
              </SectionCard>
            )}
          </>
        )}

        {tab === 'contracts' &&
          (register.length === 0 ? (
            <EmptyState
              description={t('facility-operations.common.states.emptyDescription')}
              title={t('facility-operations.common.states.emptyTitle')}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="contract-register">
                <thead>
                  <tr className="border-border-primary border-b text-left text-fg-secondary text-xs">
                    <th className="px-200 py-150 font-medium">{t(`${k}.fields.title`)}</th>
                    <th className="px-200 py-150 font-medium">{t(`${k}.contract.parties`)}</th>
                    <th className="px-200 py-150 font-medium">{t(`${k}.contract.validity`)}</th>
                    <th className="px-200 py-150 font-medium">{t(`${k}.contract.noticePeriod`)}</th>
                    <th className="px-200 py-150 font-medium">{t(`${k}.contract.owner`)}</th>
                    <th className="px-200 py-150 font-medium">{t(`${k}.contract.status`)}</th>
                  </tr>
                </thead>
                <tbody>
                  {register.map(({ depth, document }) => {
                    const contract = document.contract;
                    return (
                      <tr
                        className="cursor-pointer border-border-primary border-b last:border-b-0 hover:bg-highlight"
                        key={document.id}
                        onClick={() => setOpenId(document.id)}
                      >
                        <td className={`px-200 py-150 ${depth === 1 ? 'pl-500' : ''}`}>
                          <span className="flex flex-col">
                            <span className="font-medium">
                              {depth === 1 ? '↳ ' : ''}
                              {document.title}
                            </span>
                            {contract?.subject !== undefined && (
                              <span className="text-fg-secondary text-xs">{contract.subject}</span>
                            )}
                          </span>
                        </td>
                        <td className="px-200 py-150 text-xs">{contract?.parties.join(', ') ?? '—'}</td>
                        <td className="whitespace-nowrap px-200 py-150 text-xs">
                          {contract === undefined
                            ? '—'
                            : `${formatIsoDate(contract.validFrom, '…')} – ${contract.validTo === undefined ? t(`${k}.contract.indefinite`) : formatIsoDate(contract.validTo, '…')}`}
                        </td>
                        <td className="px-200 py-150 text-xs">{contract?.noticePeriod ?? '—'}</td>
                        <td className="px-200 py-150 text-xs">{contract?.owner ?? '—'}</td>
                        <td className="px-200 py-150">
                          <span className="flex flex-wrap gap-50">
                            {contract === undefined ? (
                              <CategoryBadge category={document.category} />
                            ) : (
                              <ContractStatusBadge status={contract.status} />
                            )}
                            {document.signature !== undefined && (
                              <Badge size="sm" variant="success">
                                {`✓ ${formatIsoDate(document.signature.signedOn, '')}`}
                              </Badge>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}

        {tab === 'deadlines' && (
          <SectionCard title={t(`${k}.deadlines.title`)}>
            <p className="-mt-100 text-fg-secondary text-sm">{t(`${k}.deadlines.description`)}</p>
            {deadlines.length === 0 ? (
              <p className="text-fg-secondary text-sm">{t(`${k}.deadlines.empty`)}</p>
            ) : (
              <ol className="flex flex-col" data-testid="deadline-list">
                {deadlines.map((entry) => (
                  <li
                    className="flex flex-wrap items-center gap-200 border-border-primary border-b py-150 last:border-b-0"
                    key={`${entry.document.id}:${entry.kind}`}
                  >
                    <span className="flex w-28 shrink-0 flex-col">
                      <span className="font-semibold text-sm">{formatIsoDate(entry.date, '')}</span>
                      <Badge size="sm" variant={deadlineVariant(entry.days)}>
                        {entry.days < 0
                          ? t(`${k}.deadlines.overdue`)
                          : entry.days === 0
                            ? t(`${k}.deadlines.today`)
                            : t(`${k}.deadlines.inDays`, { count: entry.days })}
                      </Badge>
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <button
                        className="text-left font-medium text-sm hover:underline"
                        onClick={() => setOpenId(entry.document.id)}
                        type="button"
                      >
                        {entry.document.title}
                      </button>
                      <span className="text-fg-secondary text-xs">
                        {entry.kind === 'end' ? t(`${k}.deadlines.end`) : t(`${k}.deadlines.notice`)}
                        {entry.document.contract === undefined
                          ? ''
                          : ` · ${t(`${k}.deadlines.responsible`, { name: entry.document.contract.owner })} · ${entry.document.contract.parties.slice(1).join(', ')}`}
                      </span>
                    </span>
                    {entry.document.contract !== undefined && (
                      <ContractStatusBadge status={entry.document.contract.status} />
                    )}
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        )}

        {tab === 'messages' && (
          <div className="grid grid-cols-1 gap-250 lg:grid-cols-[16rem_1fr]">
            <nav aria-label={t(`${k}.messages.channels`)} className="flex flex-col gap-100">
              <span className="font-semibold text-fg-secondary text-xs uppercase">{t(`${k}.messages.channels`)}</span>
              {channels.map((value) => {
                const count = (envelope?.state.comments ?? []).filter(
                  (comment) =>
                    comment.subject.kind === 'channel' &&
                    comment.subject.id === value &&
                    comment.retractedAt === undefined,
                ).length;
                return (
                  <button
                    aria-current={channel === value ? 'page' : undefined}
                    className={`flex flex-col rounded-lg border px-150 py-100 text-left ${channel === value ? 'border-primary bg-primary-light' : 'border-border-primary bg-surface hover:bg-highlight'}`}
                    key={value}
                    onClick={() => setChannel(value)}
                    type="button"
                  >
                    <span className="flex items-center justify-between gap-100 font-medium text-sm">
                      # {t(`${k}.messages.channel.${value}`)}
                      <Badge size="sm" variant="outline">
                        {String(count)}
                      </Badge>
                    </span>
                    <span className="text-fg-secondary text-xs">{t(`${k}.messages.channelHint.${value}`)}</span>
                  </button>
                );
              })}
            </nav>
            <SectionCard title={`# ${t(`${k}.messages.channel.${channel}`)}`}>
              <p className="-mt-100 text-fg-secondary text-sm">{t(`${k}.messages.description`)}</p>
              <CommentThread
                key={channel}
                onOpenAttachment={openAttachment}
                records={ops}
                subject={{ id: channel, kind: 'channel', label: t(`${k}.messages.channel.${channel}`) }}
                title={null}
                variant="chat"
              />
            </SectionCard>
          </div>
        )}
      </AgendaGate>

      {openDocument !== undefined && (
        <DocumentDetailPanel
          amendments={amendments}
          canWrite={canWrite}
          document={openDocument}
          onAmend={(document) => setForm({ kind: 'amend', original: document })}
          onClose={() => setOpenId(undefined)}
          onEdit={(document) => setForm({ document, kind: 'edit' })}
          onOpenDocument={(documentId) => setOpenId(documentId)}
          original={original}
          records={ops}
          run={ops.run}
        />
      )}
      <DocumentFormPanel
        contracts={contractDocs}
        tasks={tasks}
        mode={form ?? { kind: 'create' }}
        onClose={() => setForm(undefined)}
        onSaved={(documentId) => {
          setForm(undefined);
          if (documentId !== undefined) {
            setOpenId(documentId);
          }
        }}
        open={form !== undefined}
        run={ops.run}
      />
    </>
  );
};

/** Newest activity first: latest version upload or last change. */
const formatSortKey = (document: DocumentRecord) => {
  const version = document.versions.at(-1);
  return version === undefined ? formatWhenIso(document.updatedAt) : formatWhenIso(version.uploadedAt);
};
const formatWhenIso = (value: DocumentRecord['updatedAt']) => value.epochMilliseconds.toString().padStart(16, '0');

export const DocumentsPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="facility-operations.documents.title" />
    <DocumentsView />
  </AgendaFrame>
);

/** The Shell awaits this before it reveals the page, so the first render already has the documents agenda. */
export const preloadPage = preloadAgendaRecords(['documents']);
export default DocumentsPage;
