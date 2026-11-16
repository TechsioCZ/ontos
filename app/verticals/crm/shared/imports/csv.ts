// AREA: imports (C03) — owned by the crm-imports lane.
// Pure parser of the documented CRM order CSV template (crm-orders-csv-v1). The browser uses it for the preview,
// the server re-parses the same text inside the ImportOrdersCsv command, so the preview and the stored result match.
import { DateTime, Option, Result, Schema } from 'effect';
import { IsoTimeSchema, ShortTextSchema } from '../domain/common.ts';
import { CSV_TEXT_MAX_LENGTH, CsvColumnKeySchema, OrderDateSchema, OrderLineSchema } from '../domain/imports.ts';
import type { CsvColumnKey, CsvProblem } from '../domain/imports.ts';

export const ORDERS_CSV_FORMAT = 'crm-orders-csv-v1';

export interface CsvColumn {
  readonly example: string;
  readonly key: CsvColumnKey;
  readonly label: string;
  readonly required: boolean;
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

const aliases = new Map(
  Object.entries({
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
  }),
);

export interface ParsedOrderLine {
  readonly amount?: string;
  readonly name: string;
  readonly quantity: string;
  readonly sku?: string;
}

export interface ParsedOrderRow {
  readonly amount?: string;
  readonly currency?: string;
  readonly customerEmail?: string;
  readonly customerName?: string;
  readonly customerRegNo?: string;
  readonly eventAt?: typeof IsoTimeSchema.Type;
  readonly eventId?: string;
  readonly externalCustomerId?: string;
  readonly externalId: string;
  readonly lines?: readonly ParsedOrderLine[];
  readonly number?: string;
  readonly orderedAt?: typeof OrderDateSchema.Type;
  readonly rawStatus: string;
  /** Line number in the file (the header is line 1). */
  readonly row: number;
  readonly source: string;
}

export type ParsedRow =
  | { readonly kind: 'ok'; readonly value: ParsedOrderRow }
  | { readonly externalId?: string; readonly kind: 'error'; readonly problem: CsvProblem; readonly row: number };

export interface ParsedCsv {
  /** Set when the file as a whole cannot be read (no header, missing required columns). */
  readonly fileError?: CsvProblem;
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
  const [best] = counts.toSorted((left, right) => right.count - left.count);
  return best !== undefined && best.count > 0 ? best.candidate : ';';
};

interface RawRecord {
  readonly cells: readonly string[];
  readonly line: number;
}

interface UnclosedCell {
  readonly position: number;
  readonly row: number;
}

/** RFC 4180 tokenizer (quoted cells, doubled quotes, CRLF/LF, BOM). */
const tokenize = (text: string, delimiter: string): Result.Result<RawRecord[], UnclosedCell> => {
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
  if (quoted) {
    return Result.fail({ position: cells.length + 1, row: recordLine });
  }
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    records.push({ cells, line: recordLine });
  }
  return Result.succeed(records.filter((record) => record.cells.some((value) => value.trim() !== '')));
};

/** "12 450,50" / "12450.5" -> "12450.50"; undefined when not an exact decimal. */
export const normalizeDecimal = (value: string): string | undefined => {
  const compact = value.replaceAll(/[\s ]/gu, '').replace(',', '.');
  const match = /^(?<sign>-?)(?<whole>\d{1,15})(?:\.(?<fraction>\d{1,4}))?$/u.exec(compact);
  if (match === null) {
    return undefined;
  }
  const [, sign = '', whole = '0', fraction = ''] = match;
  return `${sign}${whole}.${fraction.padEnd(2, '0')}`;
};

const daysInMonth = (year: number, month: number) => {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const pragueIso = (parts: {
  readonly day: number;
  readonly hour: number;
  readonly millisecond: number;
  readonly minute: number;
  readonly month: number;
  readonly second: number;
  readonly year: number;
}): string | undefined => {
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > daysInMonth(parts.year, parts.month) ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
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
  const iso =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:[T ](?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.(?<fraction>\d{1,3}))?)?)?(?<zone>Z|[+-]\d{2}:?\d{2})?$/u.exec(
      text,
    );
  const czech =
    /^(?<day>\d{1,2})\.\s?(?<month>\d{1,2})\.\s?(?<year>\d{4})(?:\s+(?<hour>\d{1,2}):(?<minute>\d{2})(?::(?<second>\d{2}))?)?$/u.exec(
      text,
    );
  const groups = (iso ?? czech)?.groups;
  if (groups === undefined) {
    return undefined;
  }
  const year = Number(groups['year']);
  const month = Number(groups['month']);
  const day = Number(groups['day']);
  const hasTime = groups['hour'] !== undefined;
  const parts = {
    day,
    hour: Number(groups['hour'] ?? 0),
    millisecond: Number((groups['fraction'] ?? '').padEnd(3, '0')),
    minute: Number(groups['minute'] ?? 0),
    month,
    second: Number(groups['second'] ?? 0),
    year,
  };
  const local = pragueIso(parts);
  if (local === undefined) {
    return undefined;
  }
  if (!hasTime && !asInstant) {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const offset = groups['zone'];
  if (offset !== undefined) {
    return Option.getOrUndefined(DateTime.make(text.replace(' ', 'T')).pipe(Option.map(DateTime.formatIso)));
  }
  return local;
};

/** Fails with the 1-based number of the first unusable item. */
const parseLines = (value: string): Result.Result<readonly ParsedOrderLine[], number> => {
  const entries = value
    .split('|')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const lines: ParsedOrderLine[] = [];
  for (const [index, entry] of entries.entries()) {
    const fields = entry.split(':').map((field) => field.trim());
    if (fields.length < 3 || fields.length > 4) {
      return Result.fail(index + 1);
    }
    const [sku = '', name = '', quantityText = '', amountText] = fields;
    const quantity = normalizeDecimal(quantityText);
    if (name === '' || quantity === undefined) {
      return Result.fail(index + 1);
    }
    const amount = amountText === undefined || amountText === '' ? undefined : normalizeDecimal(amountText);
    if (amountText !== undefined && amountText !== '' && amount === undefined) {
      return Result.fail(index + 1);
    }
    const line: ParsedOrderLine = { name, quantity: quantity.replace(/\.00$/u, '') };
    if (sku !== '') {
      Object.assign(line, { sku });
    }
    if (amount !== undefined) {
      Object.assign(line, { amount });
    }
    if (!Schema.is(OrderLineSchema)(line)) {
      return Result.fail(index + 1);
    }
    lines.push(line);
  }
  return Result.succeed(lines);
};

const optional = (value: string | undefined) => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
};

interface ParsedMoney {
  readonly amount: ParsedOrderRow['amount'];
  readonly currency: ParsedOrderRow['currency'];
}

/** Preserve the source error priority: amount, currency spelling, then a missing currency. */
const parseMoney = (get: (key: string) => string | undefined, row: number): Result.Result<ParsedMoney, CsvProblem> => {
  const amountText = optional(get('castka'));
  const amount = amountText === undefined ? undefined : normalizeDecimal(amountText);
  if (amountText !== undefined && amount === undefined) {
    return Result.fail({ _tag: 'InvalidAmount', row, value: amountText });
  }
  const currencyText = optional(get('mena'));
  const currency = currencyText?.toUpperCase();
  if (currencyText !== undefined && currency !== undefined && !/^[A-Z]{3}$/u.test(currency)) {
    return Result.fail({ _tag: 'InvalidCurrency', row, value: currencyText });
  }
  if (amount !== undefined && currency === undefined) {
    return Result.fail({ _tag: 'AmountWithoutCurrency', row });
  }
  return Result.succeed({ amount, currency });
};

interface ParsedTimes {
  readonly eventAt: ParsedOrderRow['eventAt'];
  readonly orderedAt: ParsedOrderRow['orderedAt'];
}

/** An order may supply a civil day; an event supplies an instant. Do not mix these contracts. */
const parseTimes = (get: (key: string) => string | undefined, row: number): Result.Result<ParsedTimes, CsvProblem> => {
  const orderedText = optional(get('datum_objednavky'));
  const orderedAt =
    orderedText === undefined
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(OrderDateSchema)(parseCsvTime(orderedText, false)));
  if (orderedText !== undefined && orderedAt === undefined) {
    return Result.fail({ _tag: 'InvalidTime', column: 'datum_objednavky', row });
  }
  const eventText = optional(get('cas_udalosti'));
  const eventAt =
    eventText === undefined
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(IsoTimeSchema)(parseCsvTime(eventText, true)));
  if (eventText !== undefined && eventAt === undefined) {
    return Result.fail({ _tag: 'InvalidTime', column: 'cas_udalosti', row });
  }
  return Result.succeed({ eventAt, orderedAt });
};

/** Every text cell except the item list must fit the stored short text; items are checked one by one. */
const overlongColumn = (get: (key: string) => string | undefined) =>
  ordersCsvColumns.find((column) => {
    if (column.key === 'polozky') {
      return false;
    }
    const text = optional(get(column.key));
    return text !== undefined && !Schema.is(ShortTextSchema)(text);
  });

const parseRecord = (line: number, get: (key: string) => string | undefined): ParsedRow => {
  const source = optional(get('zdroj'));
  const externalId = optional(get('id_objednavky'));
  const rawStatus = optional(get('stav'));
  const fail = (problem: CsvProblem): ParsedRow => {
    const result: ParsedRow = {
      kind: 'error',
      problem,
      row: line,
    };
    if (Schema.is(ShortTextSchema)(externalId)) {
      Object.assign(result, { externalId });
    }
    return result;
  };
  const invalidColumn = overlongColumn(get);
  if (invalidColumn !== undefined) {
    return fail({ _tag: 'InvalidText', column: invalidColumn.key, maxLength: CSV_TEXT_MAX_LENGTH, row: line });
  }
  const missingValue = (column: CsvColumnKey) => fail({ _tag: 'MissingValue', column, row: line });
  if (source === undefined) {
    return missingValue('zdroj');
  }
  if (externalId === undefined) {
    return missingValue('id_objednavky');
  }
  if (rawStatus === undefined) {
    return missingValue('stav');
  }
  const money = parseMoney(get, line);
  if (Result.isFailure(money)) {
    return fail(money.failure);
  }
  const { amount, currency } = money.success;
  const times = parseTimes(get, line);
  if (Result.isFailure(times)) {
    return fail(times.failure);
  }
  const { eventAt, orderedAt } = times.success;
  const linesText = optional(get('polozky'));
  const parsedLines = linesText === undefined ? undefined : parseLines(linesText);
  if (parsedLines !== undefined && Result.isFailure(parsedLines)) {
    return fail({ _tag: 'InvalidLine', item: parsedLines.failure, maxLength: CSV_TEXT_MAX_LENGTH, row: line });
  }
  const lines = parsedLines?.success;
  if (currency === undefined && lines?.some((entry) => entry.amount !== undefined) === true) {
    return fail({ _tag: 'LineAmountWithoutCurrency', row: line });
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
  };
  if (lines !== undefined && lines.length > 0) {
    Object.assign(value, { lines });
  }
  if (value.customerEmail !== undefined && !Schema.is(ShortTextSchema)(value.customerEmail)) {
    return fail({ _tag: 'InvalidText', column: 'email_zakaznika', maxLength: CSV_TEXT_MAX_LENGTH, row: line });
  }
  return { kind: 'ok', value };
};

const fileFailure = (fileError: CsvProblem, unknownColumns: readonly string[] = []): ParsedCsv => ({
  fileError,
  rows: [],
  unknownColumns,
});

/** Parses CSV text of the crm-orders-csv-v1 template into validated rows and per-row problem codes. */
export const parseOrdersCsv = (text: string): ParsedCsv => {
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? '';
  const records = tokenize(text, detectDelimiter(firstLine));
  if (Result.isFailure(records)) {
    const { position, row } = records.failure;
    return fileFailure({ _tag: 'UnterminatedQuote', position, row });
  }
  const [header, ...data] = records.success;
  if (header === undefined) {
    return fileFailure({ _tag: 'EmptyFile' });
  }
  const keys = header.cells.map((cell) => {
    const folded = foldHeader(cell);
    return aliases.get(folded) ?? folded;
  });
  const invalidHeader = keys.findIndex((key) => key !== '' && !Schema.is(ShortTextSchema)(key));
  if (invalidHeader !== -1) {
    return fileFailure({ _tag: 'InvalidHeaderCell', maxLength: CSV_TEXT_MAX_LENGTH, position: invalidHeader + 1 });
  }
  const isColumnKey = Schema.is(CsvColumnKeySchema);
  const missing = ordersCsvColumns.filter((column) => column.required && !keys.includes(column.key));
  const unknownColumns = keys.filter((key) => key !== '' && !isColumnKey(key));
  const duplicate = keys.filter(isColumnKey).find((key, index, known) => known.indexOf(key) !== index);
  if (duplicate !== undefined) {
    return fileFailure({ _tag: 'DuplicateHeader', column: duplicate }, unknownColumns);
  }
  if (missing.length > 0) {
    return fileFailure({ _tag: 'MissingColumns', columns: missing.map((column) => column.key) }, unknownColumns);
  }
  const rows = data.map((record): ParsedRow => {
    if (record.cells.length > keys.length) {
      return {
        kind: 'error',
        problem: { _tag: 'SurplusCells', position: keys.length, row: record.line },
        row: record.line,
      };
    }
    return parseRecord(record.line, (key) => {
      const index = keys.indexOf(key);
      return index === -1 ? undefined : record.cells[index];
    });
  });
  return { rows, unknownColumns };
};

/** Header line + one example row; the downloadable template. */
export const ordersCsvTemplate = () =>
  `${ordersCsvColumns.map((column) => column.key).join(';')}\n${ordersCsvColumns
    .map((column) => (column.example.includes(';') ? `"${column.example}"` : column.example))
    .join(';')}\n`;
