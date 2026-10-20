// AREA: imports (C03) — owned by the crm-imports lane.
// Pure parser of the documented CRM order CSV template (crm-orders-csv-v1). The browser uses it for the preview,
// the server re-parses the same text inside the ImportOrdersCsv command, so the preview and the stored result match.
import { DateTime, Option } from 'effect';

export const ORDERS_CSV_FORMAT = 'crm-orders-csv-v1';

export interface CsvColumn {
  readonly key: string;
  readonly required: boolean;
  readonly label: string;
  readonly example: string;
}

/** The documented template. Order of columns in a file does not matter; header names do. */
export const ordersCsvColumns: readonly CsvColumn[] = [
  { example: 'E-shop', key: 'zdroj', label: 'Zdrojový systém (E-shop, Účetní systém…)', required: true },
  { example: 'VZOR-001', key: 'id_objednavky', label: 'Neměnné ID objednávky ve zdrojovém systému', required: true },
  {
    example: 'VZOR-2026-001',
    key: 'cislo_objednavky',
    label: 'Číslo objednávky zobrazované zákazníkovi',
    required: false,
  },
  {
    example: '2026-09-03',
    key: 'datum_objednavky',
    label: 'Datum objednávky (RRRR-MM-DD nebo D. M. RRRR)',
    required: false,
  },
  {
    example: 'VZOR-ZAK-001',
    key: 'id_zakaznika',
    label: 'ID zákazníka ve zdrojovém systému (pro schválenou vazbu)',
    required: false,
  },
  {
    example: 'Fiktivní zákazník s.r.o.',
    key: 'nazev_zakaznika',
    label: 'Název zákazníka podle zdroje',
    required: false,
  },
  { example: '12345678', key: 'ico_zakaznika', label: 'IČO zákazníka podle zdroje', required: false },
  {
    example: 'objednavky@example.invalid',
    key: 'email_zakaznika',
    label: 'E-mail zákazníka podle zdroje',
    required: false,
  },
  { example: '12450.00', key: 'castka', label: 'Částka objednávky (desetinná tečka nebo čárka)', required: false },
  { example: 'CZK', key: 'mena', label: 'Měna ISO 4217 (CZK, EUR…); povinná, je-li uvedena částka', required: false },
  { example: 'Vyřízeno', key: 'stav', label: 'Stav přesně tak, jak ho posílá zdroj', required: true },
  { example: '2026-09-05T14:10:00+02:00', key: 'cas_udalosti', label: 'Čas změny stavu ve zdroji', required: false },
  {
    example: 'vzor-udalost-3',
    key: 'id_udalosti',
    label: 'ID události ve zdroji (pro odstranění duplicit)',
    required: false,
  },
  {
    example: 'VZOR-01:Ukázková položka:10:6450.00|VZOR-02:Další ukázková položka:6:3000.00',
    key: 'polozky',
    label: 'Položky SKU:název:množství:částka oddělené znakem |, jen pokud je zdroj posílá',
    required: false,
  },
];

const aliases: Readonly<Record<string, string>> = {
  amount: 'castka',
  currency: 'mena',
  customer_email: 'email_zakaznika',
  customer_id: 'id_zakaznika',
  customer_name: 'nazev_zakaznika',
  customer_reg_no: 'ico_zakaznika',
  event_id: 'id_udalosti',
  event_time: 'cas_udalosti',
  external_id: 'id_objednavky',
  lines: 'polozky',
  number: 'cislo_objednavky',
  order_date: 'datum_objednavky',
  order_id: 'id_objednavky',
  source: 'zdroj',
  status: 'stav',
};

export interface ParsedOrderLine {
  readonly sku?: string;
  readonly name: string;
  readonly quantity: string;
  readonly amount?: string;
}

export interface ParsedOrderRow {
  /** Line number in the file (the header is line 1). */
  readonly row: number;
  readonly source: string;
  readonly externalId: string;
  readonly number?: string;
  readonly orderedAt?: string;
  readonly externalCustomerId?: string;
  readonly customerName?: string;
  readonly customerRegNo?: string;
  readonly customerEmail?: string;
  readonly amount?: string;
  readonly currency?: string;
  readonly rawStatus: string;
  readonly eventAt?: string;
  readonly eventId?: string;
  readonly lines?: readonly ParsedOrderLine[];
}

export type ParsedRow =
  | { readonly kind: 'ok'; readonly value: ParsedOrderRow }
  | { readonly kind: 'error'; readonly row: number; readonly message: string; readonly externalId?: string };

export interface ParsedCsv {
  /** Set when the file as a whole cannot be read (no header, missing required columns). */
  readonly fileError?: string;
  readonly rows: readonly ParsedRow[];
  readonly unknownColumns: readonly string[];
}

const foldHeader = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/gu, '_');

const detectDelimiter = (headerLine: string) => {
  const counts = [';', ',', '\t'].map((candidate) => ({
    candidate,
    count: headerLine.split(candidate).length - 1,
  }));
  const best = counts.toSorted((left, right) => right.count - left.count)[0];
  return best !== undefined && best.count > 0 ? best.candidate : ';';
};

interface RawRecord {
  readonly line: number;
  readonly cells: readonly string[];
}

/** RFC 4180 tokenizer (quoted cells, doubled quotes, CRLF/LF, BOM). */
const tokenize = (text: string, delimiter: string): RawRecord[] => {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const records: RawRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === '\n') {
          line += 1;
        }
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (char === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') {
        index += 1;
      }
      cells.push(cell);
      records.push({ cells, line: recordLine });
      cells = [];
      cell = '';
      line += 1;
      recordLine = line;
    } else {
      cell += char;
    }
  }
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    records.push({ cells, line: recordLine });
  }
  return records.filter((record) => record.cells.some((value) => value.trim() !== ''));
};

/** "12 450,50" / "12450.5" -> "12450.50"; undefined when not an exact decimal. */
export const normalizeDecimal = (value: string): string | undefined => {
  const compact = value.replaceAll(/[\s ]/gu, '').replace(',', '.');
  const match = /^(-?)(\d{1,15})(?:\.(\d{1,4}))?$/u.exec(compact);
  if (match === null) {
    return undefined;
  }
  const [, sign = '', whole = '0', fraction = ''] = match;
  return `${sign}${whole}.${fraction.padEnd(2, '0')}`;
};

const daysInMonth = (year: number, month: number) =>
  month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;

const pragueIso = (parts: {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
}): string | undefined => {
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > daysInMonth(parts.year, parts.month) ||
    parts.hours > 23 ||
    parts.minutes > 59 ||
    parts.seconds > 59
  ) {
    return undefined;
  }
  return Option.getOrUndefined(
    DateTime.makeZoned(parts, { adjustForTimeZone: true, timeZone: 'Europe/Prague' }).pipe(
      Option.map((zoned) => DateTime.formatIso(DateTime.toUtc(zoned))),
    ),
  );
};

/**
 * Date or date-time of the CSV. Date-only values stay "RRRR-MM-DD" (unless `asInstant`); date-times become UTC ISO.
 * Values without an offset are Prague local time. Returns undefined when invalid.
 */
export const parseCsvTime = (value: string, asInstant: boolean): string | undefined => {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/u.exec(
    text,
  );
  const czech = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/u.exec(text);
  const groups = iso ?? czech;
  if (groups === null) {
    return undefined;
  }
  const [year, month, day] =
    iso === null
      ? [Number(groups[3]), Number(groups[2]), Number(groups[1])]
      : [Number(groups[1]), Number(groups[2]), Number(groups[3])];
  const hasTime = groups[4] !== undefined;
  const parts = {
    day,
    hours: Number(groups[4] ?? 0),
    minutes: Number(groups[5] ?? 0),
    month,
    seconds: Number(groups[6] ?? 0),
    year,
  };
  const local = pragueIso(parts);
  if (local === undefined) {
    return undefined;
  }
  if (!hasTime && !asInstant) {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const offset = iso === null ? undefined : groups[7];
  if (offset !== undefined) {
    return Option.getOrUndefined(DateTime.make(text.replace(' ', 'T')).pipe(Option.map(DateTime.formatIso)));
  }
  return local;
};

const parseLines = (value: string): readonly ParsedOrderLine[] | string => {
  const entries = value
    .split('|')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const lines: ParsedOrderLine[] = [];
  for (const [index, entry] of entries.entries()) {
    const fields = entry.split(':').map((field) => field.trim());
    if (fields.length < 3 || fields.length > 4) {
      return `Položka ${index + 1}: očekávám SKU:název:množství:částka`;
    }
    const [sku = '', name = '', quantityText = '', amountText] = fields;
    const quantity = normalizeDecimal(quantityText);
    if (name === '' || quantity === undefined) {
      return `Položka ${index + 1}: chybí název nebo množství není číslo`;
    }
    const amount = amountText === undefined || amountText === '' ? undefined : normalizeDecimal(amountText);
    if (amountText !== undefined && amountText !== '' && amount === undefined) {
      return `Položka ${index + 1}: částka „${amountText}“ není číslo`;
    }
    lines.push({
      name,
      quantity: quantity.replace(/\.00$/u, ''),
      ...(sku === '' ? {} : { sku }),
      ...(amount === undefined ? {} : { amount }),
    });
  }
  return lines;
};

const optional = (value: string | undefined) => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
};

const parseRecord = (line: number, get: (key: string) => string | undefined): ParsedRow => {
  const source = optional(get('zdroj'));
  const externalId = optional(get('id_objednavky'));
  const rawStatus = optional(get('stav'));
  const fail = (message: string): ParsedRow => ({
    kind: 'error',
    message,
    row: line,
    ...(externalId === undefined ? {} : { externalId }),
  });
  if (source === undefined) {
    return fail('Chybí zdrojový systém (sloupec zdroj)');
  }
  if (externalId === undefined) {
    return fail('Chybí ID objednávky ve zdroji (sloupec id_objednavky)');
  }
  if (rawStatus === undefined) {
    return fail('Chybí stav objednávky (sloupec stav)');
  }
  const amountText = optional(get('castka'));
  const amount = amountText === undefined ? undefined : normalizeDecimal(amountText);
  if (amountText !== undefined && amount === undefined) {
    return fail(`Částka „${amountText}“ není platné desetinné číslo`);
  }
  const currencyText = optional(get('mena'));
  const currency = currencyText?.toUpperCase();
  if (currency !== undefined && !/^[A-Z]{3}$/u.test(currency)) {
    return fail(`Měna „${currencyText ?? ''}“ není kód ISO 4217 (např. CZK, EUR)`);
  }
  if (amount !== undefined && currency === undefined) {
    return fail('Částka bez měny: doplňte sloupec mena');
  }
  const orderedText = optional(get('datum_objednavky'));
  const orderedAt = orderedText === undefined ? undefined : parseCsvTime(orderedText, false);
  if (orderedText !== undefined && orderedAt === undefined) {
    return fail(`Datum objednávky „${orderedText}“ není platné datum`);
  }
  const eventText = optional(get('cas_udalosti'));
  const eventAt = eventText === undefined ? undefined : parseCsvTime(eventText, true);
  if (eventText !== undefined && eventAt === undefined) {
    return fail(`Čas události „${eventText}“ není platné datum a čas`);
  }
  const linesText = optional(get('polozky'));
  const lines = linesText === undefined ? undefined : parseLines(linesText);
  if (typeof lines === 'string') {
    return fail(lines);
  }
  if (currency === undefined && lines?.some((entry) => entry.amount !== undefined) === true) {
    return fail('Částka položky bez měny: doplňte sloupec mena');
  }
  const value: ParsedOrderRow = {
    externalId,
    rawStatus,
    row: line,
    source,
    ...Object.fromEntries(
      Object.entries({
        amount,
        currency,
        customerEmail: optional(get('email_zakaznika'))?.toLowerCase(),
        customerName: optional(get('nazev_zakaznika')),
        customerRegNo: optional(get('ico_zakaznika'))?.replaceAll(/\s/gu, ''),
        eventAt,
        eventId: optional(get('id_udalosti')),
        externalCustomerId: optional(get('id_zakaznika')),
        number: optional(get('cislo_objednavky')),
        orderedAt,
      }).filter(([, entry]) => entry !== undefined),
    ),
    ...(lines === undefined || lines.length === 0 ? {} : { lines }),
  };
  return { kind: 'ok', value };
};

/** Parses CSV text of the crm-orders-csv-v1 template into validated rows and readable per-row errors. */
export const parseOrdersCsv = (text: string): ParsedCsv => {
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? '';
  const records = tokenize(text, detectDelimiter(firstLine));
  const [header, ...data] = records;
  if (header === undefined) {
    return { fileError: 'Soubor je prázdný', rows: [], unknownColumns: [] };
  }
  const keys = header.cells.map((cell) => {
    const folded = foldHeader(cell);
    return aliases[folded] ?? folded;
  });
  const known = new Set(ordersCsvColumns.map((column) => column.key));
  const missing = ordersCsvColumns.filter((column) => column.required && !keys.includes(column.key));
  const unknownColumns = keys.filter((key) => key !== '' && !known.has(key));
  if (missing.length > 0) {
    return {
      fileError: `V hlavičce chybí povinné sloupce: ${missing.map((column) => column.key).join(', ')}`,
      rows: [],
      unknownColumns,
    };
  }
  const rows = data.map((record) =>
    parseRecord(record.line, (key) => {
      const index = keys.indexOf(key);
      return index === -1 ? undefined : record.cells[index];
    }),
  );
  return { rows, unknownColumns };
};

/** Header line + one example row; the downloadable template. */
export const ordersCsvTemplate = () =>
  `${ordersCsvColumns.map((column) => column.key).join(';')}\n${ordersCsvColumns
    .map((column) => (column.example.includes(';') ? `"${column.example}"` : column.example))
    .join(';')}\n`;
