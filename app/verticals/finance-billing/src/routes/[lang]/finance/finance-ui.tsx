import { InvoiceLineSchema } from '../../../../shared/apis/records.ts';
import type { InvoiceLine } from '../../../../shared/apis/records.ts';
import type { FinanceCommandSchema } from '../../../../shared/actions/apply-command.ts';
import { Data, Effect, Result, Schema } from 'effect';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { LineVatIssueSchema } from '../../../../shared/domain/line-vat.ts';
import type { useFinanceRecords } from './use-finance-records.ts';

type FinanceCommandInput = typeof FinanceCommandSchema.Encoded;
export type FinanceCommandDraft<Tag extends FinanceCommandInput['_tag']> = {
  -readonly [Key in keyof Extract<FinanceCommandInput, { readonly _tag: Tag }>]: Extract<
    FinanceCommandInput,
    { readonly _tag: Tag }
  >[Key];
};

export type FinanceViewModel = ReturnType<typeof useFinanceRecords>;

const encodeLineIdentity = Schema.encodeResult(Schema.fromJsonString(InvoiceLineSchema));
export const invoiceLineKey = (line: InvoiceLine): string => Result.getOrThrow(encodeLineIdentity(line));

/** Snapshot rows have no entity id; repeated equal snapshots get separate occurrence keys. */
export const withOccurrenceKeys = <Value,>(values: readonly Value[], identity: (value: Value) => string) => {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const content = identity(value);
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return { key: `${content}:${occurrence}`, value };
  });
};

export const ACCEPTED_DOCUMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

export interface PreparedUpload {
  readonly contentBase64: string;
  readonly fileName: string;
  readonly mimeType: string;
}

export class FinanceUploadReadError extends Data.TaggedError('FinanceUploadReadError')<{
  readonly cause: Schema.Defect['Type'];
}> {}

/** Reads a picked file as base64 (without the data-URL prefix). */
export const readUpload = (file: File): Effect.Effect<PreparedUpload, FinanceUploadReadError> =>
  Effect.callback((resume) => {
    const reader = new FileReader();
    const load = () => {
      const result = Schema.decodeUnknownEffect(Schema.String)(reader.result);
      resume(
        result.pipe(
          Effect.map((value) => {
            const comma = value.indexOf(',');
            return {
              contentBase64: comma === -1 ? value : value.slice(comma + 1),
              fileName: file.name.slice(0, 200) || 'doklad',
              mimeType: file.type,
            };
          }),
          Effect.mapError((cause) => new FinanceUploadReadError({ cause })),
        ),
      );
    };
    const fail = () => resume(Effect.fail(new FinanceUploadReadError({ cause: reader.error })));
    reader.addEventListener('load', load);
    reader.addEventListener('error', fail);
    reader.readAsDataURL(file);
    return Effect.sync(() => {
      reader.removeEventListener('load', load);
      reader.removeEventListener('error', fail);
      if (reader.readyState === FileReader.LOADING) {
        reader.abort();
      }
    });
  });

const base64Blob = (contentBase64: string, mimeType: string) => {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return new Blob([bytes], { type: mimeType });
};

const saveBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  void financeBrowserRuntime.runPromise(
    Effect.sleep('10 seconds').pipe(Effect.andThen(Effect.sync(() => URL.revokeObjectURL(url)))),
  );
};

export const downloadBase64 = (contentBase64: string, mimeType: string, fileName: string) =>
  saveBlob(base64Blob(contentBase64, mimeType), fileName);

export const downloadText = (content: string, mimeType: string, fileName: string) =>
  saveBlob(new Blob([content], { type: mimeType }), fileName);

/** Object URL for an inline preview (PDF in an iframe, images in an img). The caller revokes it. */
export const previewUrl = (contentBase64: string, mimeType: string) =>
  URL.createObjectURL(base64Blob(contentBase64, mimeType));

const kilobytesFormat = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
const megabytesFormat = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 });

export const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${kilobytesFormat.format(bytes / 1024)} kB`
    : `${megabytesFormat.format(bytes / 1024 / 1024)} MB`;

/** Parses a Czech amount typed by a user ("12 345,50") to haléře; undefined when it is not a positive amount. */
export const parseAmountMinor = (value: string): number | undefined => {
  const normalized = value.replaceAll(/\s/gu, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/u.test(normalized)) {
    return undefined;
  }
  const minor = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(minor) ? minor : undefined;
};

export const minorToInput = (minor: number | undefined) =>
  minor === undefined ? '' : (minor / 100).toFixed(2).replace('.', ',').replace(',00', '');

const MONTHS = [
  'leden',
  'únor',
  'březen',
  'duben',
  'květen',
  'červen',
  'červenec',
  'srpen',
  'září',
  'říjen',
  'listopad',
  'prosinec',
] as const;

/** "říjen 2026" for `2026-10`. */
export const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;

/** Known domain refusals in Czech; anything else falls back to the generic feedback text. */
const reasonText = {
  budget_line_already_exists: 'Rozpočtová položka pro tento měsíc, typ, kategorii a objekt už existuje.',
  confirm_requires_prepared:
    'Doklad nelze schválit, dokud není ve stavu „Připraveno ke schválení“. Nejdřív zvolte „Připravit ke schválení“.',
  contract_not_usable: 'Vybraná smlouva už v evidenci není dostupná.',
  document_kind_requires_draft: 'Druh dokladu lze změnit jen u návrhu.',
  document_too_large: 'Soubor je příliš velký (nejvýše 3 MB).',
  document_type_not_supported: 'Podporované jsou soubory PDF, PNG, JPEG a WebP.',
  export_already_confirmed: 'Předání už je potvrzené.',
  export_cannot_fail: 'Chybu lze zapsat jen u připraveného nebo předaného balíčku.',
  export_not_prepared: 'Balíček už byl předán nebo uzavřen.',
  export_requires_confirmed_invoices: 'Exportovat lze jen potvrzené (vystavené / zaevidované) doklady.',
  export_requires_handover: 'Potvrzení účetní lze zapsat až po předání balíčku.',
  incoming_invoice_already_recorded: 'Faktura s tímto číslem od stejného dodavatele už je zaevidovaná.',
  invalid_invoice_anchors_or_dates: 'Splatnost nesmí být dřív než datum vystavení.',
  invalid_line_discount: 'Sleva musí být 1–100 % nebo částka nejvýše do výše položky a musí mít důvod.',
  manual_counterparty_requires_received_invoice:
    'Ručně zapsaného dodavatele lze použít jen u přijaté faktury s vyplněným názvem dodavatele. Vlastní fakturu vystavte odběrateli z evidence.',
  payment_exceeds_remaining_amount: 'Úhrada je vyšší než zbývající částka faktury.',
  payment_requires_confirmed_invoice: 'Úhradu lze zaznamenat jen u potvrzené faktury.',
  pohoda_document_number_too_long:
    'POHODA přijme číslo dokladu nejvýše o 32 znacích. Číslo zkraťte nebo doklad předejte ve formátu CSV či JSON.',
  pohoda_text_has_forbidden_character:
    'Text dokladu obsahuje neviditelný řídicí znak, který soubor POHODA neunese. Opravte text dokladu a balíček vytvořte znovu.',
  pohoda_vat_rate_unsupported:
    'Doklad obsahuje sazbu DPH, kterou POHODA nezná (podporuje 0, 10, 12 a 21 %). Předejte ho ve formátu CSV či JSON.',
  prepare_requires_draft: 'Ke schválení lze připravit jen návrhy.',
  price_list_item_already_exists: 'Aktivní položka ceníku se stejným názvem už existuje.',
  prior_settlement_exceeds_paid_amount: 'Částka přesahuje uhrazenou a dosud nezohledněnou část dřívějšího dokladu.',
  prior_settlement_exceeds_total: 'Součet zohledněných částek přesahuje celkovou částku faktury.',
  prior_settlement_invoice_not_eligible:
    'Zohlednit lze jen potvrzenou zálohovou nebo dílčí fakturu stejného odběratele.',
  prior_settlement_requires_draft: 'Zohlednění předchozích dokladů lze měnit jen u návrhu.',
  prior_settlement_requires_final_or_partial: 'Předchozí doklady se zohledňují jen u konečné nebo dílčí faktury.',
  property_not_usable: 'Vybraná nemovitost není aktivní nebo nepatří vybrané firmě.',
  recurring_period_already_generated: 'Pro toto období už faktura z této šablony existuje.',
  recurring_template_inactive: 'Šablona je pozastavená.',
  reminder_requires_open_invoice: 'Upomínku lze připravit jen k neuhrazené potvrzené faktuře.',
  supplier_document_number_required: 'U přijaté faktury vyplňte číslo dokladu dodavatele.',
  unit_property_mismatch: 'Vybraná jednotka nepatří k vybrané nemovitosti.',
} satisfies Readonly<Record<string, string>>;

/**
 * The Czech explanation of a known refusal. A `code: detail` reason names what to correct (e.g. the document
 * number of the affected invoice); that detail is kept after the explanation.
 */
export const knownReasonText = (reason: string | undefined): string | undefined => {
  const known = Object.entries(reasonText).find(([key]) => reason?.includes(key) === true);
  if (reason === undefined || known === undefined) {
    return undefined;
  }
  const [key, explanation] = known;
  const prefix = `${key}: `;
  return reason.startsWith(prefix) ? `${explanation} (${reason.slice(prefix.length)})` : explanation;
};

export const outcomeMessage = (
  vm: FinanceViewModel,
  outcome: { readonly feedback: string; readonly reason?: string },
) => {
  // A VAT refusal names what to change on the line, in the reader's language.
  const vatIssue = LineVatIssueSchema.literals.find((code) => outcome.reason?.includes(code) === true);
  if (vatIssue !== undefined) {
    return vm.t(`finance-billing.vat.rejected.${vatIssue}`);
  }
  return knownReasonText(outcome.reason) ?? vm.t(`finance-billing.demo.feedback.${outcome.feedback}`);
};

/** A command outcome as a panel shows it; `default` is neutral information, `error` a refusal or failure. */
export interface FinanceNotice {
  readonly status: 'default' | 'error';
  readonly text: string;
}

/** True for a command an approver must still accept: nothing was written, and nothing failed either. */
export const isPendingApproval = (outcome: { readonly feedback?: string; readonly ok: boolean }): boolean =>
  !outcome.ok && outcome.feedback === 'pendingApproval';

/** A failed or parked command's message: a proposal waiting for approval reads as information, never an error. */
export const outcomeNotice = (
  vm: FinanceViewModel,
  outcome: { readonly feedback: string; readonly ok: false; readonly reason?: string },
): FinanceNotice =>
  isPendingApproval(outcome)
    ? { status: 'default', text: vm.t('finance-billing.demo.feedback.pendingApproval') }
    : { status: 'error', text: outcomeMessage(vm, outcome) };
