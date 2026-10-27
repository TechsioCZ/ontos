// Facility operations — Dokumenty a smlouvy (S12) + Interní zprávy (S14). OWNED BY THE `documents` LANE (ops-documents).
// Data: useAgendaRecords(['documents']); commands: shared/commands/documents.ts; files via FileUpload + records read.
import { EmptyState, PageHeader, SectionCard, StatCard, StatRow, foldSearchText } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Input } from '@techsio/ui-kit/atoms/input';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Tabs } from '@techsio/ui-kit/molecules/tabs';
import { DataTable } from '@techsio/ui-kit/organisms/data-table';
import type { CellContext, ColumnDef } from '@techsio/ui-kit/organisms/data-table';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { DateTime, Option, Schema } from 'effect';
import { TaskRefSchema } from '@app/work-tasks/resources/task';
import { optionalField } from '../../../../../shared/domain/common.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useState } from 'react';
import type { DocumentRecord, SubjectRef } from '../../../../../shared/domain/documents.ts';
import { DocumentIdSchema, documentLinks } from '../../../../../shared/domain/documents.ts';
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
import { DocumentDetailPanel } from './document-detail.tsx';
import { DocumentFormPanel, documentFormKey } from './document-form.tsx';
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
const emptyTitleKey = 'facility-operations.common.states.emptyTitle';
const channels = ['provoz', 'vedeni', 'technika'] as const;
const tabs = ['all', 'contracts', 'deadlines', 'messages'] as const;
type Tab = (typeof tabs)[number];

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

const DocumentTitleCell = ({ row }: CellContext<DocumentRecord>) => {
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

const DocumentCategoryCell = ({ row }: CellContext<DocumentRecord>) => (
  <span className="flex flex-wrap items-center gap-50">
    <CategoryBadge category={row.original.category} />
    {row.original.contract !== undefined && <ContractStatusBadge status={row.original.contract.status} />}
  </span>
);

const DocumentLinksCell = ({ row }: CellContext<DocumentRecord>) => <LinksCell document={row.original} />;

const DocumentVersionsCell = ({ row }: CellContext<DocumentRecord>) =>
  row.original.versions.length === 0 ? (
    <span className="text-fg-secondary text-xs">—</span>
  ) : (
    <Badge size="sm" variant="outline">
      {`v${row.original.versions.at(-1)?.version ?? 1}`}
    </Badge>
  );

const DocumentUploadedCell = ({ row }: CellContext<DocumentRecord>) => {
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

const pragueDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' });
/** A responsible person is shown only when the contract record states one. */
const ownerOf = (document: DocumentRecord) => document.contract?.owner ?? '';
const financeOwnerOf = (row: FinanceFileRow) => row.file.actorLabel ?? '';
/** Date of the last change in the Prague business calendar. */
const changedOn = (document: DocumentRecord) => pragueDay.format(DateTime.toEpochMillis(document.updatedAt));
const financeChangedOn = (row: FinanceFileRow) => pragueDay.format(DateTime.toEpochMillis(row.file.uploadedAt));

const formatWhenIso = (value: DocumentRecord['updatedAt']) => value.epochMilliseconds.toString().padStart(16, '0');

/** Newest activity first: latest version upload or last change. */
const formatSortKey = (document: DocumentRecord) => {
  const version = document.versions.at(-1);
  return version === undefined ? formatWhenIso(document.updatedAt) : formatWhenIso(version.uploadedAt);
};

const deadlineText = (days: number, t: ReturnType<typeof useModernI18n>['t']): string => {
  if (days < 0) {
    return t(`${k}.deadlines.overdue`);
  }
  if (days === 0) {
    return t(`${k}.deadlines.today`);
  }
  return t(`${k}.deadlines.inDays`, { count: days });
};

const DocumentsSearchSchema = Schema.Struct({
  doc: Schema.optionalKey(Schema.Union([DocumentIdSchema, Schema.Array(DocumentIdSchema)])),
  taskId: Schema.optionalKey(
    Schema.Union([TaskRefSchema.fields.resourceId, Schema.Array(TaskRefSchema.fields.resourceId)]),
  ),
});
export const validateSearch = Schema.toStandardSchemaV1(DocumentsSearchSchema);
const firstSearchValue = (value: string | readonly string[] | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (Schema.is(Schema.String)(value)) {
    return value;
  }
  return value[0];
};
const emptyFilters = { category: ALL, changedFrom: '', changedTo: '', link: ALL, owner: ALL, query: '' };
type DocumentsFilterInputs = typeof emptyFilters;

const documentColumns = (t: ReturnType<typeof useModernI18n>['t']): ColumnDef<DocumentRecord>[] => [
  {
    cell: DocumentTitleCell,
    header: t(`${k}.fields.title`),
    id: 'title',
    meta: { width: '36%' },
  },
  {
    cell: DocumentCategoryCell,
    header: t(`${k}.fields.category`),
    id: 'category',
    meta: { width: '14%' },
  },
  {
    cell: DocumentLinksCell,
    header: t(`${k}.fields.links`),
    id: 'links',
    meta: { width: '26%' },
  },
  {
    cell: DocumentVersionsCell,
    header: t(`${k}.fields.versions`),
    id: 'versions',
    meta: { width: '8%' },
  },
  {
    cell: DocumentUploadedCell,
    header: t(`${k}.fields.uploadedAt`),
    id: 'uploaded',
    meta: { width: '16%' },
  },
];

const DocumentsFilterControls = ({
  filtersActive,
  linkOptions,
  onChange,
  onClear,
  owners,
  value: filterInputs,
}: {
  readonly filtersActive: boolean;
  readonly linkOptions: readonly (readonly [string, SubjectRef])[];
  readonly onChange: (patch: Partial<DocumentsFilterInputs>) => void;
  readonly onClear: () => void;
  readonly owners: readonly string[];
  readonly value: DocumentsFilterInputs;
}) => {
  const { t } = useModernI18n();
  const categoryLabel = useCategoryLabel();
  const { category, changedFrom, changedTo, link, owner, query } = filterInputs;
  return (
    <div className="flex flex-wrap items-end gap-150">
      <Input
        aria-label={t(`${k}.filters.search`)}
        className="w-80"
        onChange={(event) => onChange({ query: event.target.value })}
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
          onValueChange={({ value }) => onChange({ category: value[0] ?? ALL })}
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
          onValueChange={({ value }) => onChange({ owner: value[0] ?? ALL })}
          size="sm"
          value={[owner]}
        />
      </div>
      <div className="w-40">
        <FormInput
          id="documents-changed-from"
          label={t(`${k}.filters.changedFrom`)}
          onChange={(event) => onChange({ changedFrom: event.target.value })}
          size="sm"
          type="date"
          value={changedFrom}
        />
      </div>
      <div className="w-40">
        <FormInput
          id="documents-changed-to"
          label={t(`${k}.filters.changedTo`)}
          onChange={(event) => onChange({ changedTo: event.target.value })}
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
          onValueChange={({ value }) => onChange({ link: value[0] ?? ALL })}
          size="sm"
          value={[link]}
        />
      </div>
      {filtersActive && (
        <Button
          onClick={() => {
            onClear();
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

const DocumentsList = ({
  columns,
  filtered,
  filtersActive,
  onOpenDocument,
}: {
  readonly columns: ColumnDef<DocumentRecord>[];
  readonly filtered: DocumentRecord[];
  readonly filtersActive: boolean;
  readonly onOpenDocument: (id: string) => void;
}) => {
  const { t } = useModernI18n();
  return (
    <>
      <div className="facility-documents-desktop">
        <DataTable
          columns={columns}
          data={filtered}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.original.title}
          loading={false}
          onRowClick={(row) => onOpenDocument(row.original.id)}
          size="sm"
          tableLayout="fixed"
          translations={{
            emptyDescription: filtersActive
              ? t(`${k}.filters.noMatch`)
              : t('facility-operations.common.states.emptyDescription'),
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
              onClick={() => onOpenDocument(document.id)}
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
    </>
  );
};

const FinanceDocumentFiles = ({
  financeFiles,
  financeFiltered,
  lang,
  totalFiles,
}: {
  readonly financeFiles: ReturnType<typeof useFinanceFiles>;
  readonly financeFiltered: FinanceFileRow[];
  readonly lang: 'cs' | 'en';
  readonly totalFiles: number;
}) => {
  const { t } = useModernI18n();
  if (financeFiles.status === 'forbidden') {
    return null;
  }
  return (
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
            {totalFiles === 0 ? 'Ve Financích zatím nejsou nahrané žádné soubory.' : t(`${k}.filters.noMatch`)}
          </p>
        ) : (
          <FinanceFilesList language={lang} rows={financeFiltered} />
        ))}
    </SectionCard>
  );
};

const DocumentsContractRegister = ({
  onOpenDocument,
  register,
}: {
  readonly onOpenDocument: (id: string) => void;
  readonly register: ReturnType<typeof contractRegister>;
}) => {
  const { t } = useModernI18n();
  return register.length === 0 ? (
    <EmptyState description={t('facility-operations.common.states.emptyDescription')} title={t(emptyTitleKey)} />
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
            return (
              <tr
                className="cursor-pointer border-border-primary border-b last:border-b-0 hover:bg-highlight"
                key={document.id}
                onClick={() => onOpenDocument(document.id)}
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
                    : [
                        formatIsoDate(contract.validFrom, '…'),
                        contract.validTo === undefined
                          ? t(`${k}.contract.indefinite`)
                          : formatIsoDate(contract.validTo, '…'),
                      ].join(' – ')}
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

const DocumentsDeadlines = ({
  deadlines,
  onOpenDocument,
}: {
  readonly deadlines: ReturnType<typeof upcomingDeadlines>;
  readonly onOpenDocument: (id: string) => void;
}) => {
  const { t } = useModernI18n();
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
                  {deadlineText(entry.days, t)}
                </Badge>
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <button
                  className="text-left font-medium text-sm hover:underline"
                  onClick={() => onOpenDocument(entry.document.id)}
                  type="button"
                >
                  {entry.document.title}
                </button>
                <span className="text-fg-secondary text-xs">
                  {entry.kind === 'end' ? t(`${k}.deadlines.end`) : t(`${k}.deadlines.notice`)}
                  {entry.document.contract === undefined
                    ? ''
                    : [
                        '',
                        t(`${k}.deadlines.responsible`, { name: entry.document.contract.owner }),
                        entry.document.contract.parties.slice(1).join(', '),
                      ].join(' · ')}
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

const DocumentsMessages = ({
  channel,
  onChannelChange,
  openAttachment,
  ops,
}: {
  readonly channel: (typeof channels)[number];
  readonly onChannelChange: (channel: (typeof channels)[number]) => void;
  readonly openAttachment: (subject: SubjectRef) => void;
  readonly ops: ReturnType<typeof useAgendaRecords>;
}) => {
  const { t } = useModernI18n();
  return (
    <div className="grid grid-cols-1 gap-250 lg:grid-cols-[16rem_1fr]">
      <nav aria-label={t(`${k}.messages.channels`)} className="flex flex-col gap-100">
        <span className="font-semibold text-fg-secondary text-xs uppercase">{t(`${k}.messages.channels`)}</span>
        {channels.map((value) => {
          const count = (ops.data?.agendas.documents?.state.comments ?? []).filter(
            (comment) =>
              comment.subject.kind === 'channel' && comment.subject.id === value && comment.retractedAt === undefined,
          ).length;
          return (
            <button
              aria-current={channel === value ? 'page' : undefined}
              className={`flex flex-col rounded-lg border px-150 py-100 text-left ${channel === value ? 'border-primary bg-primary-light' : 'border-border-primary bg-surface hover:bg-highlight'}`}
              key={value}
              onClick={() => onChannelChange(value)}
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
      <SectionCard title={['#', t(`${k}.messages.channel.${channel}`)].join(' ')}>
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

const documentLinkOptions = (documents: readonly DocumentRecord[]) => {
  const links = new Map<string, SubjectRef>();
  for (const document of documents) {
    for (const entry of documentLinks(document)) {
      const linkable =
        entry.kind === 'property' ||
        entry.kind === 'unit' ||
        entry.kind === 'tenant' ||
        entry.kind === 'contact' ||
        entry.kind === 'invoice' ||
        entry.kind === 'task';
      if (linkable) {
        links.set(`${entry.kind}:${entry.id}`, entry);
      }
    }
  }
  return [...links.entries()].toSorted(([, left], [, right]) => left.label.localeCompare(right.label, 'cs'));
};

const documentRelations = (documents: readonly DocumentRecord[], documentId: string | undefined) => {
  const document = documents.find((entry) => entry.id === documentId);
  const original =
    document?.amendsDocumentId === undefined
      ? undefined
      : documents.find((entry) => entry.id === document.amendsDocumentId);
  return {
    amendments: document === undefined ? [] : documents.filter((entry) => entry.amendsDocumentId === document.id),
    document,
    original,
  };
};

const useDocumentsViewModel = () => {
  const { language, t } = useModernI18n();
  const lang: 'cs' | 'en' = language?.startsWith('en') ? 'en' : 'cs';
  const financeFiles = useFinanceFiles();
  const categoryLabel = useCategoryLabel();
  const navigate = useNavigate();
  const search = useRouterState({
    select: (state) =>
      Option.getOrElse(
        Schema.decodeUnknownOption(validateSearch)(state.location.search),
        (): typeof DocumentsSearchSchema.Type => ({}),
      ),
  });
  const ops = useAgendaRecords(['documents']);
  const tasks = useTaskOptions();
  const requestedTaskId = firstSearchValue(search.taskId);
  const taskSubject = tasks.status === 'ready' ? tasks.options.find((task) => task.id === requestedTaskId) : undefined;
  const envelope = ops.data?.agendas.documents;
  const documents = envelope?.state.documents ?? [];
  const canWrite = envelope?.canWrite === true;
  const today = todayInPrague();

  const [tab, setTab] = useState<Tab>('all');
  const [filters, setFilters] = useState(emptyFilters);
  const { category, changedFrom, changedTo, link, owner, query } = filters;
  const openId = firstSearchValue(search.doc);
  const setOpenId = (documentId: string | undefined) => {
    void navigate({
      hash: true,
      replace: true,
      search: (previous: typeof DocumentsSearchSchema.Encoded) => {
        const { doc: _doc, ...otherSearch } = previous;
        return { ...otherSearch, ...optionalField('doc', documentId) };
      },
      to: '.',
    });
  };
  const [form, setForm] = useState<DocumentFormMode | undefined>();
  const [channel, setChannel] = useState<(typeof channels)[number]>('provoz');

  const filter = { category: category === ALL ? '' : category, link: link === ALL ? '' : link, query };
  const financeAll = financeFiles.status === 'ready' ? financeFiles.rows : [];
  const owners = [
    ...new Set([...documents.map(ownerOf), ...financeAll.map(financeOwnerOf)].filter((name) => name !== '')),
  ].toSorted((left, right) => left.localeCompare(right, 'cs'));
  const financeLinkMatches = (row: FinanceFileRow) => {
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
  // Invoice files uploaded in Finance, read through with the person's own Finance permission (read-only here).
  const financeFiltered = financeAll.filter(
    (row) =>
      (category === ALL || category === 'invoice') &&
      (owner === ALL || financeOwnerOf(row) === owner) &&
      financeLinkMatches(row) &&
      (query.trim() === '' || foldSearchText(financeFileText(row)).includes(foldSearchText(query.trim()))) &&
      (changedFrom === '' || financeChangedOn(row) >= changedFrom) &&
      (changedTo === '' || financeChangedOn(row) <= changedTo),
  );
  const filtered = documents
    .filter(
      (document) =>
        matchesFilter(document, filter) &&
        (owner === ALL || ownerOf(document) === owner) &&
        (changedFrom === '' || changedOn(document) >= changedFrom) &&
        (changedTo === '' || changedOn(document) <= changedTo),
    )
    .toSorted((left, right) => formatSortKey(right).localeCompare(formatSortKey(left)));
  const filtersActive =
    query !== '' || category !== ALL || link !== ALL || owner !== ALL || changedFrom !== '' || changedTo !== '';
  const downloadCsv = () => {
    browserRuntime.runFork(
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
            [financeInvoiceLabel(row.invoice), row.invoice?.counterpartyName ?? '']
              .filter((part) => part !== '')
              .join(', '),
            row.file.fileName,
            financeChangedOn(row),
          ]),
        ],
      }),
    );
  };
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
  const linkOptions = documentLinkOptions(documents);
  const { amendments, document: openDocument, original } = documentRelations(documents, openId);
  const openAttachment = (subject: SubjectRef) => {
    if (subject.kind === 'document') {
      setOpenId(subject.id);
    }
  };

  const columns = documentColumns(t);

  return {
    activeContracts,
    amendments,
    canWrite,
    channel,
    columns,
    contractDocs,
    deadlines,
    documents,
    downloadCsv,
    envelope,
    expiringSoon,
    filtered,
    filters,
    filtersActive,
    financeAll,
    financeFiles,
    financeFiltered,
    form,
    lang,
    linkOptions,
    openAttachment,
    openDocument,
    ops,
    original,
    owners,
    register,
    requestedTaskId,
    setChannel,
    setFilters,
    setForm,
    setOpenId,
    setTab,
    t,
    tab,
    tasks,
    taskSubject,
    versionCount,
  };
};

const DocumentsView = () => {
  const {
    activeContracts,
    amendments,
    canWrite,
    channel,
    columns,
    contractDocs,
    deadlines,
    documents,
    downloadCsv,
    envelope,
    expiringSoon,
    filtered,
    filters,
    filtersActive,
    financeAll,
    financeFiles,
    financeFiltered,
    form,
    lang,
    linkOptions,
    openAttachment,
    openDocument,
    ops,
    original,
    owners,
    register,
    requestedTaskId,
    setChannel,
    setFilters,
    setForm,
    setOpenId,
    setTab,
    t,
    tab,
    tasks,
    taskSubject,
    versionCount,
  } = useDocumentsViewModel();
  return (
    <>
      <PageHeader
        actions={
          envelope === undefined ? undefined : (
            <>
              <Button
                onClick={() => {
                  downloadCsv();
                }}
                size="sm"
                theme="borderless"
                variant="secondary"
              >
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
        onRetry={() => {
          browserRuntime.runFork(ops.reload());
        }}
        readable={envelope !== undefined}
        status={ops.status}
      >
        {taskSubject !== undefined && (
          <SectionCard title={[t(`${k}.linked.taskTitle`), taskSubject.label].join(' · ')}>
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

        {tab === 'all' && (
          <>
            <DocumentsFilterControls
              filtersActive={filtersActive}
              linkOptions={linkOptions}
              onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
              onClear={() => setFilters(emptyFilters)}
              owners={owners}
              value={filters}
            />
            <DocumentsList
              columns={columns}
              filtered={filtered}
              filtersActive={filtersActive}
              onOpenDocument={setOpenId}
            />
            <FinanceDocumentFiles
              financeFiles={financeFiles}
              financeFiltered={financeFiltered}
              lang={lang}
              totalFiles={financeAll.length}
            />
          </>
        )}

        {tab === 'contracts' && <DocumentsContractRegister onOpenDocument={setOpenId} register={register} />}

        {tab === 'deadlines' && <DocumentsDeadlines deadlines={deadlines} onOpenDocument={setOpenId} />}

        {tab === 'messages' && (
          <DocumentsMessages channel={channel} onChannelChange={setChannel} openAttachment={openAttachment} ops={ops} />
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
      {form !== undefined && (
        <DocumentFormPanel
          contracts={contractDocs}
          key={documentFormKey(form)}
          mode={form}
          onClose={() => setForm(undefined)}
          onSaved={(documentId) => {
            setForm(undefined);
            if (documentId !== undefined) {
              setOpenId(documentId);
            }
          }}
          open
          run={ops.run}
          tasks={tasks}
        />
      )}
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
