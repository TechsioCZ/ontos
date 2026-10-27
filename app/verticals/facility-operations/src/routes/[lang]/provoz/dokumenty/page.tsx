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
import { Effect, Result, Schema } from 'effect';
import { useState } from 'react';
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
} from '../../../../ui/documents-kit.tsx';
import { preloadAgendaRecords, useAgendaRecords } from '../../../../ui/use-agenda.ts';
import { exportCsv } from '../../../../ui/ops-agenda/ui-bits.tsx';
import { LinkedDocuments } from '../../../../ui/linked-documents.tsx';
import { LoadingSkeleton } from '../../../../ui/loading-skeleton.tsx';
import { useTaskOptions } from '../../../../ui/task-options.ts';
import {
  FinanceFilesList,
  financeFileText,
  financeInvoiceLabel,
  useFinanceFiles,
} from '../../../../ui/finance-files.tsx';
import type { FinanceFileRow } from '../../../../ui/finance-files.tsx';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { changedOn, documentSortKey, DocumentsSearchSchema, selectionForSearch } from './documents-route-state.ts';
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
const tabs = ['all', 'contracts', 'deadlines', 'messages'] as const;
const TabSchema = Schema.Literals(tabs);
type Tab = typeof TabSchema.Type;
const emptyTitleKey = 'facility-operations.common.states.emptyTitle';
const emptyDescriptionKey = 'facility-operations.common.states.emptyDescription';

interface DocumentsFilter {
  readonly category: string;
  readonly changedFrom: string;
  readonly changedTo: string;
  readonly link: string;
  readonly owner: string;
  readonly query: string;
}
const ownerOf = (document: DocumentRecord) => document.contract?.owner ?? '';
const financeOwnerOf = (row: FinanceFileRow) => row.file.actorLabel ?? '';
const financeLinkMatches = (row: FinanceFileRow, link: string) => {
  if (link === ALL) {
    return true;
  }
  const [kind, ...rest] = link.split(':');
  const id = rest.join(':');
  if (kind === 'invoice') {
    return row.invoice?.ref.resourceId === id;
  }
  return kind === 'contact' && row.invoice?.counterpartyRef.resourceId === id;
};
const financeMatchesFilter = (row: FinanceFileRow, filter: DocumentsFilter) =>
  (filter.category === ALL || filter.category === 'invoice') &&
  (filter.owner === ALL || financeOwnerOf(row) === filter.owner) &&
  financeLinkMatches(row, filter.link) &&
  (filter.query.trim() === '' || foldSearchText(financeFileText(row)).includes(foldSearchText(filter.query.trim()))) &&
  (filter.changedFrom === '' || changedOn(row.file.uploadedAt) >= filter.changedFrom) &&
  (filter.changedTo === '' || changedOn(row.file.uploadedAt) <= filter.changedTo);
const documentMatchesFilter = (document: DocumentRecord, filter: DocumentsFilter) =>
  matchesFilter(document, {
    category: filter.category === ALL ? '' : filter.category,
    link: filter.link === ALL ? '' : filter.link,
    query: filter.query,
  }) &&
  (filter.owner === ALL || ownerOf(document) === filter.owner) &&
  (filter.changedFrom === '' || changedOn(document.updatedAt) >= filter.changedFrom) &&
  (filter.changedTo === '' || changedOn(document.updatedAt) <= filter.changedTo);
const documentOwners = (documents: readonly DocumentRecord[], financeRows: readonly FinanceFileRow[]) => {
  const names = new Set<string>();
  for (const document of documents) {
    const name = ownerOf(document);
    if (name !== '') {
      names.add(name);
    }
  }
  for (const row of financeRows) {
    const name = financeOwnerOf(row);
    if (name !== '') {
      names.add(name);
    }
  }
  return [...names].toSorted((left, right) => left.localeCompare(right, 'cs'));
};
const documentSummary = (documents: readonly DocumentRecord[], today: string) => {
  const contractDocs = documents.filter(isContractDocument);
  const register = contractRegister(documents);
  const deadlines = upcomingDeadlines(documents, today);
  const expiringSoon = deadlines.filter((entry) => entry.kind === 'end' && entry.days >= 0 && entry.days <= 30).length;
  const activeContracts = contractDocs.filter(
    (document) => document.contract?.status === 'active' && document.amendsDocumentId === undefined,
  ).length;
  let versionCount = 0;
  for (const document of documents) {
    versionCount += document.versions.length;
  }
  return { activeContracts, contractDocs, deadlines, expiringSoon, register, versionCount };
};
const filterableLinkKinds = new Set(['property', 'unit', 'tenant', 'contact', 'invoice', 'task']);
const documentLinkOptions = (documents: readonly DocumentRecord[]) => {
  const options = new Map<string, SubjectRef>();
  for (const document of documents) {
    for (const entry of documentLinks(document)) {
      if (filterableLinkKinds.has(entry.kind)) {
        options.set(`${entry.kind}:${entry.id}`, entry);
      }
    }
  }
  return [...options.entries()].toSorted(([, left], [, right]) => left.label.localeCompare(right.label, 'cs'));
};

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

interface DocumentCellProps {
  readonly row: { readonly original: DocumentRecord };
}
const DocumentTitleCell = ({ row }: DocumentCellProps) => {
  const { t } = useModernI18n();
  const version = row.original.versions.at(-1);
  return (
    <span className="flex min-w-0 items-center gap-150">
      <FileTypeIcon mime={version?.file.mime ?? ''} name={version?.file.name ?? ''} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{row.original.title}</span>
        <span className="truncate text-fg-secondary text-xs">
          {version === undefined ? t(`${k}.noFileYet`) : `${version.file.name} · ${formatBytes(version.file.size)}`}
        </span>
      </span>
    </span>
  );
};
const DocumentCategoryCell = ({ row }: DocumentCellProps) => (
  <span className="flex flex-wrap items-center gap-50">
    <CategoryBadge category={row.original.category} />
    {row.original.contract !== undefined && <ContractStatusBadge status={row.original.contract.status} />}
  </span>
);
const DocumentLinksCell = ({ row }: DocumentCellProps) => <LinksCell document={row.original} />;
const DocumentVersionsCell = ({ row }: DocumentCellProps) =>
  row.original.versions.length === 0 ? (
    <span className="text-fg-secondary text-xs">—</span>
  ) : (
    <Badge size="sm" variant="outline">{`v${row.original.versions.at(-1)?.version ?? 1}`}</Badge>
  );
const DocumentUploadedCell = ({ row }: DocumentCellProps) => {
  const { t } = useModernI18n();
  const version = row.original.versions.at(-1);
  return version === undefined ? (
    <span className="text-fg-secondary text-xs">{t(`${k}.noFileYet`)}</span>
  ) : (
    <span className="flex flex-col">
      <span className="text-fg-secondary text-xs">{formatWhen(version.uploadedAt)}</span>
    </span>
  );
};
const useDocumentColumns = (): ColumnDef<DocumentRecord>[] => {
  const { t } = useModernI18n();
  return [
    { cell: DocumentTitleCell, header: t(`${k}.fields.title`), id: 'title', meta: { width: '36%' } },
    { cell: DocumentCategoryCell, header: t(`${k}.fields.category`), id: 'category', meta: { width: '14%' } },
    { cell: DocumentLinksCell, header: t(`${k}.fields.links`), id: 'links', meta: { width: '26%' } },
    { cell: DocumentVersionsCell, header: t(`${k}.fields.versions`), id: 'versions', meta: { width: '8%' } },
    { cell: DocumentUploadedCell, header: t(`${k}.fields.uploadedAt`), id: 'uploaded', meta: { width: '16%' } },
  ];
};

const useDocumentsModel = () => {
  const { language, t } = useModernI18n();
  const lang = language?.startsWith('en') ? 'en' : 'cs';
  const financeFiles = useFinanceFiles();
  const categoryLabel = useCategoryLabel();
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const ops = useAgendaRecords(['documents']);
  const tasks = useTaskOptions();
  const searchResult = Schema.decodeResult(DocumentsSearchSchema)(searchStr);
  const requestedTaskId = Result.isSuccess(searchResult) ? searchResult.success.taskId : undefined;
  const requestedDocument = Result.isSuccess(searchResult) ? searchResult.success.doc : undefined;
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
  const [selection, setSelection] = useState(() => selectionForSearch(undefined, searchStr, requestedDocument));
  if (selection.searchKey !== searchStr) {
    setSelection(selectionForSearch(selection, searchStr, requestedDocument));
  }
  const { openId } = selection;
  const setOpenId = (id: string | undefined) => setSelection({ openId: id, searchKey: searchStr });
  const [form, setForm] = useState<DocumentFormMode>();
  const [channel, setChannel] = useState<(typeof channels)[number]>('provoz');

  const filters = { category, changedFrom, changedTo, link, owner, query };
  const financeAll = financeFiles.status === 'ready' ? financeFiles.rows : [];
  const owners = documentOwners(documents, financeAll);
  const financeFiltered = financeAll.filter((row) => financeMatchesFilter(row, filters));
  const filtered = documents
    .filter((document) => documentMatchesFilter(document, filters))
    .toSorted((left, right) => documentSortKey(right).localeCompare(documentSortKey(left)));
  const filtersActive =
    query !== '' || category !== ALL || link !== ALL || owner !== ALL || changedFrom !== '' || changedTo !== '';
  const downloadCsv = () => {
    const input = {
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
          changedOn(document.updatedAt),
        ]),
        ...financeFiltered.map((row) => [
          row.file.fileName,
          `${categoryLabel('invoice')} (Finance)`,
          financeOwnerOf(row),
          [financeInvoiceLabel(row.invoice), row.invoice?.counterpartyName ?? '']
            .filter((part) => part !== '')
            .join(', '),
          row.file.fileName,
          changedOn(row.file.uploadedAt),
        ]),
      ],
    };
    browserRuntime.runFork(
      Effect.promise(exportCsv.bind(undefined, input)).pipe(Effect.asVoid, Effect.timeout('30 seconds')),
    );
  };
  const retry = () => {
    browserRuntime.runFork(Effect.promise(ops.reload).pipe(Effect.timeout('30 seconds')));
  };
  const { activeContracts, contractDocs, deadlines, expiringSoon, register, versionCount } = documentSummary(
    documents,
    today,
  );
  const linkOptions = documentLinkOptions(documents);
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

  return {
    activeContracts,
    amendments,
    canWrite,
    category,
    changedFrom,
    changedTo,
    channel,
    contractDocs,
    deadlines,
    documents,
    downloadCsv,
    envelope,
    expiringSoon,
    filtered,
    filtersActive,
    financeAll,
    financeFiles,
    financeFiltered,
    form,
    lang,
    link,
    linkOptions,
    openAttachment,
    openDocument,
    openId,
    ops,
    original,
    owner,
    owners,
    query,
    register,
    requestedTaskId,
    retry,
    searchResult,
    setCategory,
    setChangedFrom,
    setChangedTo,
    setChannel,
    setForm,
    setLink,
    setOpenId,
    setOwner,
    setQuery,
    setTab,
    tab,
    tasks,
    taskSubject,
    today,
    versionCount,
  };
};
type DocumentsModel = ReturnType<typeof useDocumentsModel>;

const DocumentsFilters = ({ model }: { readonly model: DocumentsModel }) => {
  const { t } = useModernI18n();
  const categoryLabel = useCategoryLabel();
  const {
    category,
    changedFrom,
    changedTo,
    filtersActive,
    link,
    linkOptions,
    owner,
    owners,
    query,
    setCategory,
    setChangedFrom,
    setChangedTo,
    setLink,
    setOwner,
    setQuery,
  } = model;
  return (
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
  );
};

const DocumentsListing = ({ model }: { readonly model: DocumentsModel }) => {
  const { t } = useModernI18n();
  const columns = useDocumentColumns();
  const { filtered, filtersActive, financeAll, financeFiles, financeFiltered, lang, setOpenId } = model;
  return (
    <>
      <DocumentsFilters model={model} />{' '}
      <div className="facility-documents-desktop">
        <DataTable
          columns={columns}
          data={filtered}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.original.title}
          loading={false}
          onRowClick={(row) => setOpenId(row.original.id)}
          size="sm"
          tableLayout="fixed"
          translations={{
            emptyDescription: filtersActive ? t(`${k}.filters.noMatch`) : t(emptyDescriptionKey),
            emptyTitle: t(emptyTitleKey),
          }}
        />
      </div>
      <div className="facility-documents-mobile">
        {filtered.length === 0 && <EmptyState description={t(`${k}.filters.noMatch`)} title={t(emptyTitleKey)} />}
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
                    : `${formatWhen(version.uploadedAt)} · ${formatBytes(version.file.size)}`}
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
            Doklady a přílohy nahrané k fakturám ve Financích. Zobrazují se jen ke čtení podle vašeho oprávnění ve
            Financích; nahrávají a mění se u faktury.
          </p>
          {financeFiles.status === 'loading' && <LoadingSkeleton rows={2} />}
          {financeFiles.status === 'unavailable' && (
            <p className="text-fg-secondary text-sm">Soubory z Financí jsou teď nedostupné. Zkuste stránku obnovit.</p>
          )}
          {financeFiles.status === 'ready' &&
            (financeFiltered.length === 0 ? (
              <p className="text-fg-secondary text-sm">
                {financeAll.length === 0
                  ? 'Ve Financích zatím nejsou nahrané žádné soubory.'
                  : t(`${k}.filters.noMatch`)}
              </p>
            ) : (
              <FinanceFilesList language={lang} rows={financeFiltered} />
            ))}
        </SectionCard>
      )}
    </>
  );
};

const ContractsTab = ({ model }: { readonly model: DocumentsModel }) => {
  const { t } = useModernI18n();
  const { register, setOpenId } = model;
  return register.length === 0 ? (
    <EmptyState description={t(emptyDescriptionKey)} title={t(emptyTitleKey)} />
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
            const { contract } = document;
            const validityEnd =
              contract?.validTo === undefined ? t(`${k}.contract.indefinite`) : formatIsoDate(contract.validTo, '…');
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
                  {contract === undefined ? '—' : `${formatIsoDate(contract.validFrom, '…')} – ${validityEnd}`}
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
  );
};

const deadlineLabel = (days: number, t: ReturnType<typeof useModernI18n>['t']) => {
  if (days < 0) {
    return t(`${k}.deadlines.overdue`);
  }
  if (days === 0) {
    return t(`${k}.deadlines.today`);
  }
  return t(`${k}.deadlines.inDays`, { count: days });
};
const DeadlinesTab = ({ model }: { readonly model: DocumentsModel }) => {
  const { t } = useModernI18n();
  const { deadlines, setOpenId } = model;
  const responsibleKey = `${k}.deadlines.responsible`;
  return (
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
                  {deadlineLabel(entry.days, t)}
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
                    : ` · ${t(responsibleKey, { name: entry.document.contract.owner })} · ${entry.document.contract.parties.slice(1).join(', ')}`}
                </span>
              </span>
              {entry.document.contract !== undefined && <ContractStatusBadge status={entry.document.contract.status} />}
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
};

const MessagesTab = ({ model }: { readonly model: DocumentsModel }) => {
  const { t } = useModernI18n();
  const { channel, envelope, openAttachment, ops, setChannel } = model;
  const channelTitle = t(`${k}.messages.channel.${channel}`);
  return (
    <div className="grid grid-cols-1 gap-250 lg:grid-cols-[16rem_1fr]">
      <nav aria-label={t(`${k}.messages.channels`)} className="flex flex-col gap-100">
        <span className="font-semibold text-fg-secondary text-xs uppercase">{t(`${k}.messages.channels`)}</span>
        {channels.map((value) => {
          const count = (envelope?.state.comments ?? []).filter(
            (comment) =>
              comment.subject.kind === 'channel' && comment.subject.id === value && comment.retractedAt === undefined,
          ).length;
          const selectedClass =
            channel === value
              ? 'border-primary bg-primary-light'
              : 'border-border-primary bg-surface hover:bg-highlight';
          return (
            <button
              aria-current={channel === value ? 'page' : undefined}
              className={`flex flex-col rounded-lg border px-150 py-100 text-left ${selectedClass}`}
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
      <SectionCard title={`# ${channelTitle}`}>
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
  );
};

const DocumentsView = () => {
  const model = useDocumentsModel();
  const { t } = useModernI18n();
  const linkedTaskTitle = t(`${k}.linked.taskTitle`);
  const {
    activeContracts,
    amendments,
    canWrite,
    contractDocs,
    deadlines,
    documents,
    downloadCsv,
    envelope,
    expiringSoon,
    financeAll,
    financeFiles,
    form,
    openDocument,
    ops,
    original,
    requestedTaskId,
    retry,
    searchResult,
    setForm,
    setOpenId,
    setTab,
    tab,
    tasks,
    taskSubject,
    versionCount,
  } = model;
  return (
    <>
      <PageHeader
        actions={
          envelope === undefined ? undefined : (
            <>
              <Button onClick={downloadCsv} size="sm" theme="borderless" variant="secondary">
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
      <AgendaGate
        onRetry={retry}
        readable={envelope !== undefined}
        status={Result.isFailure(searchResult) ? 'error' : ops.status}
      >
        {taskSubject !== undefined && (
          <SectionCard title={`${linkedTaskTitle} · ${taskSubject.label}`}>
            <a className="text-sm underline" href={`/cs/ukoly?resourceId=${encodeURIComponent(taskSubject.id)}`}>
              {t(`${k}.linked.backToTask`)}
            </a>
            <LinkedDocuments records={ops} subject={taskSubject} />
          </SectionCard>
        )}
        {requestedTaskId !== undefined && taskSubject === undefined && (
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

        {tab === 'all' && <DocumentsListing model={model} />}
        {tab === 'contracts' && <ContractsTab model={model} />}
        {tab === 'deadlines' && <DeadlinesTab model={model} />}
        {tab === 'messages' && <MessagesTab model={model} />}
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
        tasks={tasks}
      />
    </>
  );
};

export const DocumentsPage = () => (
  <AgendaFrame>
    <UltramodernRouteHead titleKey="facility-operations.documents.title" />
    <DocumentsView />
  </AgendaFrame>
);

/** The Shell awaits this before it reveals the page, so the first render already has the documents agenda. */
export const preloadPage = preloadAgendaRecords(['documents']);
export default DocumentsPage;
