// @effect-diagnostics asyncFunction:off globalTimers:off
// Documents lane (ops-documents): shared presentation helpers for documents, files and comments.
// Other lanes may import these, but the components to embed are CommentThread and LinkedDocuments.
import { formatDateTime } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { DateTime } from 'effect';
import { DateTime as DateTimeModule } from 'effect';
import type { DocumentRecord, SubjectRef } from '../../shared/domain/documents.ts';
import { loadRecords } from './use-agenda.ts';

const k = 'facility-operations.documents';

export const isoOf = (value: DateTime.Utc) => DateTimeModule.formatIso(value);

/** Localised date + time of a UTC instant. */
export const formatWhen = (value: DateTime.Utc) => {
  const iso = DateTimeModule.formatIso(value);
  return formatDateTime(iso);
};

export const formatBytes = (size: number) => {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toLocaleString('cs-CZ', { maximumFractionDigits: 0 })} kB`;
  }
  return `${(size / 1024 / 1024).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} MB`;
};

export type FileKind = 'pdf' | 'image' | 'word' | 'sheet' | 'text' | 'other';

export const fileKindOf = (mime: string, name: string): FileKind => {
  const lower = name.toLowerCase();
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
    return 'pdf';
  }
  if (mime.startsWith('image/')) {
    return 'image';
  }
  if (mime.includes('word') || lower.endsWith('.docx') || lower.endsWith('.doc')) {
    return 'word';
  }
  if (mime.includes('sheet') || mime.includes('excel') || lower.endsWith('.xlsx') || lower.endsWith('.csv')) {
    return 'sheet';
  }
  if (mime.startsWith('text/')) {
    return 'text';
  }
  return 'other';
};

const fileBadge: Readonly<Record<FileKind, { readonly label: string; readonly tone: string }>> = {
  image: { label: 'IMG', tone: 'bg-info-light text-fg-primary' },
  other: { label: 'FILE', tone: 'bg-highlight text-fg-secondary' },
  pdf: { label: 'PDF', tone: 'bg-danger-light text-fg-primary' },
  sheet: { label: 'XLS', tone: 'bg-success-light text-fg-primary' },
  text: { label: 'TXT', tone: 'bg-highlight text-fg-secondary' },
  word: { label: 'DOC', tone: 'bg-primary-light text-fg-primary' },
};

/** Small file-type tile used in lists. */
export const FileTypeIcon = ({ mime, name }: { readonly mime: string; readonly name: string }) => {
  const badge = fileBadge[fileKindOf(mime, name)];
  return (
    <span
      aria-hidden="true"
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md font-bold text-xs tracking-wide ${badge.tone}`}
    >
      {badge.label}
    </span>
  );
};

export const documentCategories = [
  'contract',
  'amendment',
  'annex',
  'protocol',
  'revision',
  'invoice',
  'photo',
  'plan',
  'other',
] as const;

/** Category label, tolerating free-text categories from older records. */
export const useCategoryLabel = () => {
  const { t } = useModernI18n();
  return (category: string) =>
    (documentCategories as readonly string[]).includes(category) ? t(`${k}.categories.${category}`) : category;
};

/** Subject kind label, tolerating kinds introduced by other lanes. */
export const useKindLabel = () => {
  const { t } = useModernI18n();
  return (kind: string) => t(`${k}.kinds.${kind}`, { defaultValue: t(`${k}.kinds.other`) });
};

export const categoryVariant = (category: string) => {
  if (category === 'contract') {
    return 'primary' as const;
  }
  if (category === 'amendment' || category === 'annex') {
    return 'info' as const;
  }
  if (category === 'revision' || category === 'protocol') {
    return 'warning' as const;
  }
  return 'outline' as const;
};

export const CategoryBadge = ({ category }: { readonly category: string }) => {
  const label = useCategoryLabel();
  return (
    <Badge size="sm" variant={categoryVariant(category)}>
      {label(category)}
    </Badge>
  );
};

/** Compact chip for a linked record. */
export const SubjectChip = ({
  subject,
  onRemove,
  removeLabel,
}: {
  readonly subject: SubjectRef;
  readonly onRemove?: () => void;
  readonly removeLabel?: string;
}) => {
  const kindLabel = useKindLabel();
  return (
    <span className="inline-flex max-w-full items-center gap-50 rounded-full bg-surface px-150 py-50 text-xs">
      <span className="text-fg-secondary">{kindLabel(subject.kind)}</span>
      <span className="truncate font-medium">{subject.label}</span>
      {onRemove !== undefined && (
        <button
          aria-label={removeLabel}
          className="ml-50 rounded-full px-50 text-fg-secondary hover:text-fg-primary"
          onClick={onRemove}
          type="button"
        >
          ×
        </button>
      )}
    </span>
  );
};

export const currentVersion = (document: DocumentRecord) => document.versions.at(-1);

const decodeBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/** Loads a stored file through the governed records read (server checks documents read access). */
export const fetchFileObjectUrl = async (
  fileId: string,
): Promise<
  { readonly ok: true; readonly url: string; readonly mime: string; readonly name: string } | { readonly ok: false }
> => {
  const outcome = await loadRecords({ agendas: [], fileId });
  if (!outcome.ok || outcome.data.file === undefined) {
    return { ok: false };
  }
  const stored = outcome.data.file;
  const url = URL.createObjectURL(new Blob([decodeBase64(stored.contentBase64)], { type: stored.mime }));
  return { mime: stored.mime, name: stored.name, ok: true, url };
};

/** Whole days from today (Europe/Prague business date) to an ISO date; negative when in the past. */
export const daysUntil = (isoDate: string, today: string) => {
  const target = Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)));
  const base = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  return Math.round((target - base) / 86_400_000);
};

/** Today's business date in Prague as `YYYY-MM-DD`. */
export const todayInPrague = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format();

/** `d. M. yyyy` for an ISO calendar date. */
export const formatIsoDate = (isoDate: string | undefined, fallback: string) => {
  if (isoDate === undefined) {
    return fallback;
  }
  return `${Number(isoDate.slice(8, 10))}. ${Number(isoDate.slice(5, 7))}. ${isoDate.slice(0, 4)}`;
};
