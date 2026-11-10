// The quote panel's values: a new quote is submitted once, an edit of an existing one is sent on Uložit.
import { Option } from 'effect';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type { IsoDateSchema } from '../../../../../shared/domain/common.ts';
import type { SalesCustomer, SalesQuote } from '../../../../../shared/domain/purchasing.ts';
import { parseAmountMinor } from './purchasing-model.ts';

type UpdateCommand = Extract<OpsCommand, { readonly _tag: 'SalesQuoteUpdate' }>;
type QuoteLine = UpdateCommand['lines'][number];
/** One quote line as typed, without the editor's row key. */
export interface QuoteLineDraft {
  readonly description: string;
  readonly price: string;
  readonly quantity: string;
  readonly vat: QuoteLine['vatRate'];
}

export interface QuoteDraft {
  readonly customerId: string;
  readonly date: typeof IsoDateSchema.Encoded;
  readonly lines: readonly QuoteLineDraft[];
  readonly note: string;
  readonly validUntil: typeof IsoDateSchema.Encoded;
}

const emptyLine: QuoteLineDraft = { description: '', price: '', quantity: '1', vat: 21 };

export const quoteDraftOf = (quote?: SalesQuote): QuoteDraft => ({
  customerId: quote?.customer.counterpartyId ?? '',
  date: quote?.date ?? '',
  lines: quote?.lines.map((line) => ({
    description: line.description,
    price: String(line.unitPriceMinor / 100).replace('.', ','),
    quantity: String(line.quantity),
    vat: line.vatRate,
  })) ?? [emptyLine],
  note: quote?.note ?? '',
  validUntil: quote?.validUntil ?? '',
});

const parsePositiveInt = (raw: string): number | undefined => {
  const value = Number(raw.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
};

const parsedLine = (line: QuoteLineDraft): QuoteLine | undefined => {
  const quantity = parsePositiveInt(line.quantity);
  const unitPriceMinor = parseAmountMinor(line.price);
  const description = line.description.trim();
  return description === '' || quantity === undefined || unitPriceMinor === undefined
    ? undefined
    : { description, quantity, unitPriceMinor, vatRate: line.vat };
};

/** Drafts that store the same quote: surrounding spaces and the editor's row keys do not count. */
export const sameQuoteDraft = (left: QuoteDraft, right: QuoteDraft): boolean =>
  left.customerId === right.customerId &&
  left.date === right.date &&
  left.validUntil === right.validUntil &&
  left.note.trim() === right.note.trim() &&
  left.lines.length === right.lines.length &&
  left.lines.every((line, index) => {
    const other = right.lines[index];
    return (
      other !== undefined &&
      line.description.trim() === other.description.trim() &&
      line.price.trim() === other.price.trim() &&
      line.quantity.trim() === other.quantity.trim() &&
      line.vat === other.vat
    );
  });

/** The update an edit sends; None while a line, the customer or the validity is not usable. */
export const quoteUpdateCommandOf = (
  draft: QuoteDraft,
  quote: SalesQuote,
  customer?: SalesCustomer,
): Option.Option<OpsCommand> => {
  if (customer === undefined || draft.date === '') {
    return Option.none();
  }
  if (draft.validUntil !== '' && draft.validUntil < draft.date) {
    return Option.none();
  }
  const lines: QuoteLine[] = [];
  for (const line of draft.lines) {
    const parsed = parsedLine(line);
    if (parsed === undefined) {
      return Option.none();
    }
    lines.push(parsed);
  }
  const command: { -readonly [Key in keyof UpdateCommand]: UpdateCommand[Key] } = {
    _tag: 'SalesQuoteUpdate',
    customer,
    date: draft.date,
    lines,
    quoteId: quote.id,
  };
  // An edit keeps the quote where it is in its lifecycle: sending it is the create action.
  const validUntil = draft.validUntil.trim();
  if (validUntil !== '') {
    command.validUntil = validUntil;
  }
  const note = draft.note.trim();
  if (note !== '') {
    command.note = note;
  }
  return Option.some(command);
};
