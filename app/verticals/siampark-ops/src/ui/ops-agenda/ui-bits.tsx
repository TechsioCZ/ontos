// @effect-diagnostics asyncFunction:off globalDate:off globalTimers:off
// Small visual building blocks of the calendar / overview pages (ops-agenda lane). Colours come from the ui-kit
// theme variables with neutral fallbacks, applied inline so they never depend on class scanning.
import type { CSSProperties, ReactNode } from 'react';
import type { Tone } from './model.ts';
import { runCommand } from '../use-agenda.ts';
import { toCsv } from './deadlines.ts';
import type { DeadlineCategory, Urgency } from './deadlines.ts';
import type { SourceStatus } from './sources.ts';

const palette: Record<Tone, { readonly bg: string; readonly fg: string; readonly accent: string; readonly ring: string }> = {
  danger: {
    accent: 'var(--color-danger-500, #dc2626)',
    bg: 'var(--color-danger-100, #fee2e2)',
    fg: 'var(--color-danger-800, #991b1b)',
    ring: 'var(--color-danger-300, #fca5a5)',
  },
  info: { accent: '#2563eb', bg: '#e8f0fe', fg: '#1e3a8a', ring: '#93c5fd' },
  neutral: {
    accent: 'var(--color-neutral-500, #6b7280)',
    bg: 'var(--color-neutral-100, #f3f4f6)',
    fg: 'var(--color-neutral-700, #374151)',
    ring: 'var(--color-neutral-300, #d1d5db)',
  },
  primary: {
    accent: 'var(--color-primary-500, #d4a106)',
    bg: 'var(--color-primary-100, #fef3c7)',
    fg: 'var(--color-primary-900, #713f12)',
    ring: 'var(--color-primary-300, #fcd34d)',
  },
  success: {
    accent: 'var(--color-success-500, #16a34a)',
    bg: 'var(--color-success-100, #dcfce7)',
    fg: 'var(--color-success-800, #166534)',
    ring: 'var(--color-success-300, #86efac)',
  },
  warning: {
    accent: 'var(--color-warning-500, #ea580c)',
    bg: 'var(--color-warning-100, #ffedd5)',
    fg: 'var(--color-warning-800, #9a3412)',
    ring: 'var(--color-warning-300, #fdba74)',
  },
};

export const toneColors = (tone: Tone) => palette[tone];

export const categoryTone: Record<DeadlineCategory, Tone> = {
  assetService: 'neutral',
  contractEnd: 'warning',
  contractNotice: 'warning',
  contractStart: 'success',
  event: 'primary',
  inspection: 'danger',
  invoiceDue: 'info',
  leaseEnd: 'warning',
  leaseStart: 'success',
  meterReading: 'info',
  opsDeadline: 'neutral',
  task: 'primary',
};

export const urgencyTone: Record<Urgency, Tone> = {
  done: 'neutral',
  later: 'neutral',
  overdue: 'danger',
  soon: 'warning',
  today: 'primary',
};

export const statusTone: Record<SourceStatus, Tone> = {
  forbidden: 'neutral',
  loading: 'neutral',
  ready: 'success',
  unavailable: 'danger',
};

/** Rounded label in a tone; `solid` for strong emphasis. */
export const Pill = ({
  children,
  solid = false,
  title,
  tone,
}: {
  readonly children: ReactNode;
  readonly solid?: boolean;
  readonly title?: string;
  readonly tone: Tone;
}) => {
  const colors = palette[tone];
  const style: CSSProperties = solid
    ? { background: colors.accent, color: '#fff' }
    : { background: colors.bg, color: colors.fg };
  return (
    <span
      className="siamparkops:inline-flex siamparkops:items-center siamparkops:gap-1 siamparkops:whitespace-nowrap siamparkops:rounded-full siamparkops:px-2 siamparkops:py-0.5 siamparkops:text-xs siamparkops:font-medium"
      style={style}
      title={title}
    >
      {children}
    </span>
  );
};

export const Dot = ({ tone, size = 8 }: { readonly tone: Tone; readonly size?: number }) => (
  <span
    aria-hidden
    className="siamparkops:inline-block siamparkops:shrink-0 siamparkops:rounded-full"
    style={{ background: palette[tone].accent, height: size, width: size }}
  />
);

// ---- Icons (inline SVG, Material Design paths) -------------------------------------------------------------------

const paths = {
  alert: 'M13 14h-2V9h2m0 9h-2v-2h2M1 21h22L12 2 1 21Z',
  arrowRight: 'M4 11v2h12l-5.5 5.5 1.42 1.42L19.84 12l-7.92-7.92L10.5 5.5 16 11H4Z',
  bell: 'M21 19v1H3v-1l2-2v-6c0-3.1 2.03-5.83 5-6.71V4a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.29c2.97.88 5 3.61 5 6.71v6l2 2m-7 2a2 2 0 0 1-2 2 2 2 0 0 1-2-2',
  building:
    'M18 15h-2v2h2m0-6h-2v2h2m2 6h-8v-2h2v-2h-2v-2h2v-2h-2V9h8M10 7H8V5h2m0 6H8V9h2m0 6H8v-2h2m0 6H8v-2h2M6 7H4V5h2m0 6H4V9h2m0 6H4v-2h2m0 6H4v-2h2m6-10V3H2v18h20V7H12Z',
  calendar:
    'M19 19H5V8h14m-3-7v2H8V1H6v2H5c-1.11 0-2 .89-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-1V1m-1 11h-5v5h5v-5Z',
  check: 'M21 7 9 19l-5.5-5.5 1.41-1.41L9 16.17 19.59 5.59 21 7Z',
  chevronLeft: 'M15.41 16.58 10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.42Z',
  chevronRight: 'M8.59 16.58 13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.42Z',
  clipboard:
    'M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2m-7 0a1 1 0 0 1 1 1 1 1 0 0 1-1 1 1 1 0 0 1-1-1 1 1 0 0 1 1-1M7 7h10V5h2v14H5V5h2v2m5 10-4-4 1.4-1.4 2.6 2.6 5.6-5.6L19 10l-7 7Z',
  contract:
    'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6m4 18H6V4h7v5h5v11m-3.5-6.5c0 1.38-1.12 2.5-2.5 2.5S9.5 14.88 9.5 13.5 10.62 11 12 11s2.5 1.12 2.5 2.5M16 19H8v-1c0-1.33 2.67-2 4-2s4 .67 4 2v1Z',
  download: 'M5 20h14v-2H5m14-9h-4V3H9v6H5l7 7 7-7Z',
  info: 'M13 9h-2V7h2m0 10h-2v-6h2m-1-9A10 10 0 0 0 2 12a10 10 0 0 0 10 10 10 10 0 0 0 10-10A10 10 0 0 0 12 2Z',
  invoice:
    'M3 22V3h18v19l-3-2-3 2-3-2-3 2-3-2-3 2M17 9V7H7v2h10m-2 4v-2H7v2h8Z',
  key: 'M7 14a2 2 0 0 1-2-2 2 2 0 0 1 2-2 2 2 0 0 1 2 2 2 2 0 0 1-2 2m5.65-4A5.99 5.99 0 0 0 7 6a6 6 0 0 0-6 6 6 6 0 0 0 6 6 5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65Z',
  lock: 'M12 17a2 2 0 0 0 2-2 2 2 0 0 0-2-2 2 2 0 0 0-2 2 2 2 0 0 0 2 2m6-9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h1V6a5 5 0 0 1 5-5 5 5 0 0 1 5 5v2h1m-6-5a3 3 0 0 0-3 3v2h6V6a3 3 0 0 0-3-3Z',
  magnify:
    'M9.5 3A6.5 6.5 0 0 1 16 9.5c0 1.61-.59 3.09-1.56 4.23l.27.27h.79l5 5-1.5 1.5-5-5v-.79l-.27-.27A6.516 6.516 0 0 1 9.5 16 6.5 6.5 0 0 1 3 9.5 6.5 6.5 0 0 1 9.5 3m0 2C7 5 5 7 5 9.5S7 14 9.5 14 14 12 14 9.5 12 5 9.5 5Z',
  refresh:
    'M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 0 0-8 8 8 8 0 0 0 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18a6 6 0 0 1-6-6 6 6 0 0 1 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z',
  shield: 'M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4m0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8Z',
  tasks:
    'M3 5h6v6H3V5m2 2v2h2V7H5m6 0h10v2H11V7m0 8h10v2H11v-2m-6 5-3.5-3.5 1.41-1.41L5 17.17l4.59-4.58L11 14l-6 6Z',
  timer:
    'M12 20a7 7 0 0 1-7-7 7 7 0 0 1 7-7 7 7 0 0 1 7 7 7 7 0 0 1-7 7m7.03-12.61 1.42-1.42c-.45-.51-.9-.97-1.41-1.41L17.62 6c-1.55-1.26-3.5-2-5.62-2a9 9 0 0 0-9 9 9 9 0 0 0 9 9c5 0 9-4.03 9-9 0-2.12-.74-4.07-1.97-5.61M11 14h2V8h-2m4-7H9v2h6V1Z',
} as const;

export type IconName = keyof typeof paths;

export const Icon = ({ name, size = 20, color }: { readonly name: IconName; readonly size?: number; readonly color?: string }) => (
  <svg aria-hidden height={size} style={{ color, flexShrink: 0 }} viewBox="0 0 24 24" width={size}>
    <path d={paths[name]} fill="currentColor" />
  </svg>
);

/** Tinted circle with an icon (KPI tiles, empty states). */
export const IconBadge = ({ name, tone, size = 40 }: { readonly name: IconName; readonly tone: Tone; readonly size?: number }) => (
  <span
    aria-hidden
    className="siamparkops:inline-flex siamparkops:shrink-0 siamparkops:items-center siamparkops:justify-center siamparkops:rounded-xl"
    style={{ background: palette[tone].bg, color: palette[tone].accent, height: size, width: size }}
  >
    <Icon name={name} size={Math.round(size * 0.55)} />
  </span>
);

// ---- Dates ---------------------------------------------------------------------------------------------------------

const longDate = {
  cs: new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'long', timeZone: 'UTC', weekday: 'long', year: 'numeric' }),
  en: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC', weekday: 'long', year: 'numeric' }),
};
const shortDate = {
  cs: new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', timeZone: 'UTC', year: 'numeric' }),
  en: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC', year: 'numeric' }),
};
const dayMonth = {
  cs: new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
  en: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
};
const weekdayShort = {
  cs: new Intl.DateTimeFormat('cs-CZ', { timeZone: 'UTC', weekday: 'short' }),
  en: new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }),
};
const monthYear = {
  cs: new Intl.DateTimeFormat('cs-CZ', { month: 'long', timeZone: 'UTC', year: 'numeric' }),
  en: new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC', year: 'numeric' }),
};
const clock = {
  cs: new Intl.DateTimeFormat('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' }),
  en: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' }),
};
const stamp = {
  cs: new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Prague' }),
  en: new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Prague' }),
};

type Lang = 'cs' | 'en';
export const langOf = (language: string | undefined): Lang => (language === 'en' ? 'en' : 'cs');
const utc = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`);

export const fmt = {
  clock: (lang: Lang, iso: string) => clock[lang].format(Date.parse(iso)),
  dayMonth: (lang: Lang, date: string) => dayMonth[lang].format(utc(date)),
  long: (lang: Lang, date: string) => longDate[lang].format(utc(date)),
  monthYear: (lang: Lang, date: string) => monthYear[lang].format(utc(date)),
  short: (lang: Lang, date: string) => shortDate[lang].format(utc(date)),
  stamp: (lang: Lang, iso: string) => stamp[lang].format(Date.parse(iso)),
  weekday: (lang: Lang, date: string) => weekdayShort[lang].format(utc(date)),
};

// ---- CSV export --------------------------------------------------------------------------------------------------

/**
 * Downloads a CSV of exactly the given (already permission-filtered, currently filtered) rows and logs the export
 * in the agenda export log when the person may write the agenda. Logging never blocks the download.
 */
export const exportCsv = async (input: {
  readonly fileName: string;
  readonly list: string;
  readonly filter?: string;
  readonly header: readonly string[];
  readonly rows: readonly (readonly (string | number | undefined)[])[];
  readonly log: boolean;
  /** Current revision of the agenda state (export log). */
  readonly revision: number;
}) => {
  const blob = new Blob([toCsv(input.header, input.rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = input.fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  if (input.log) {
    await runCommand(
      {
        _tag: 'AgendaExportRecord',
        list: input.list,
        rowCount: input.rows.length,
        ...(input.filter === undefined || input.filter === '' ? {} : { filter: input.filter.slice(0, 500) }),
      },
      input.revision,
    );
  }
};
