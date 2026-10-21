// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import { Badge } from '@techsio/ui-kit/atoms/badge';
import type { useFinanceRecords } from './use-finance-records.ts';

export type FinanceViewModel = ReturnType<typeof useFinanceRecords>;

/** Visible marker for anything the demo only simulates (delivery, foreign formats). */
export const SimulationBadge = ({ children = 'SIMULACE' }: { readonly children?: string }) => (
  <Badge size="sm" variant="warning">
    {children}
  </Badge>
);

export const ACCEPTED_DOCUMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

export interface PreparedUpload {
  readonly contentBase64: string;
  readonly fileName: string;
  readonly mimeType: string;
}

/** Reads a picked file as base64 (without the data-URL prefix). */
export const readUpload = (file: File): Promise<PreparedUpload> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve({
        contentBase64: comma === -1 ? result : result.slice(comma + 1),
        fileName: file.name.slice(0, 200) || 'doklad',
        mimeType: file.type,
      });
    });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('read_failed')));
    reader.readAsDataURL(file);
  });

const base64Blob = (contentBase64: string, mimeType: string) => {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
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
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

export const downloadBase64 = (contentBase64: string, mimeType: string, fileName: string) =>
  saveBlob(base64Blob(contentBase64, mimeType), fileName);

export const downloadText = (content: string, mimeType: string, fileName: string) =>
  saveBlob(new Blob([content], { type: mimeType }), fileName);

/** Object URL for an inline preview (PDF in an iframe, images in an img). The caller revokes it. */
export const previewUrl = (contentBase64: string, mimeType: string) =>
  URL.createObjectURL(base64Blob(contentBase64, mimeType));

export const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 }).format(bytes / 1024)} kB`
    : `${new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;

/** Parses a Czech amount typed by a user ("12 345,50") to haléře; undefined when it is not a positive amount. */
export const parseAmountMinor = (value: string): number | undefined => {
  const normalized = value.replaceAll(/\s/gu, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/u.test(normalized)) {
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
export const shortMonthLabel = (month: string) =>
  `${(MONTHS[Number(month.slice(5, 7)) - 1] ?? month).slice(0, 3)} ${month.slice(2, 4)}`;

/** Known domain refusals in Czech; anything else falls back to the generic feedback text. */
export const reasonText: Readonly<Record<string, string>> = {
  budget_line_already_exists: 'Rozpočtová položka pro tento měsíc, typ, kategorii a objekt už existuje.',
  confirm_requires_prepared:
    'Doklad nelze schválit, dokud není ve stavu „Připraveno ke schválení“. Nejdřív zvolte „Připravit ke schválení“.',
  contract_not_usable: 'Vybraná smlouva už v evidenci není dostupná.',
  document_kind_requires_draft: 'Druh dokladu lze změnit jen u návrhu.',
  export_cannot_fail: 'Chybu lze zapsat jen u připraveného nebo předaného balíčku.',
  export_not_prepared: 'Balíček už byl předán nebo uzavřen.',
  export_requires_handover: 'Potvrzení účetní lze zapsat až po předání balíčku.',
  invalid_line_discount: 'Sleva musí být 1–100 % nebo částka nejvýše do výše položky a musí mít důvod.',
  prepare_requires_draft: 'Ke schválení lze připravit jen návrhy.',
  price_list_item_already_exists: 'Aktivní položka ceníku se stejným názvem už existuje.',
  prior_settlement_exceeds_paid_amount: 'Částka přesahuje uhrazenou a dosud nezohledněnou část dřívějšího dokladu.',
  prior_settlement_exceeds_total: 'Součet zohledněných částek přesahuje celkovou částku faktury.',
  prior_settlement_invoice_not_eligible:
    'Zohlednit lze jen potvrzenou zálohovou nebo dílčí fakturu stejného odběratele.',
  prior_settlement_requires_draft: 'Zohlednění předchozích dokladů lze měnit jen u návrhu.',
  prior_settlement_requires_final_or_partial: 'Předchozí doklady se zohledňují jen u konečné nebo dílčí faktury.',
  property_not_usable: 'Vybraná nemovitost není aktivní nebo nepatří vybrané firmě.',
  unit_property_mismatch: 'Vybraná jednotka nepatří k vybrané nemovitosti.',
  document_too_large: 'Soubor je příliš velký (nejvýše 3 MB).',
  document_type_not_supported: 'Podporované jsou soubory PDF, PNG, JPEG a WebP.',
  export_already_confirmed: 'Předání už je potvrzené.',
  export_requires_confirmed_invoices: 'Exportovat lze jen potvrzené (vystavené / zaevidované) doklady.',
  incoming_invoice_already_recorded: 'Faktura s tímto číslem od stejného dodavatele už je zaevidovaná.',
  invalid_invoice_anchors_or_dates: 'Splatnost nesmí být dřív než datum vystavení.',
  payment_exceeds_remaining_amount: 'Úhrada je vyšší než zbývající částka faktury.',
  payment_requires_confirmed_invoice: 'Úhradu lze zaznamenat jen u potvrzené faktury.',
  recurring_period_already_generated: 'Pro toto období už faktura z této šablony existuje.',
  recurring_template_inactive: 'Šablona je pozastavená.',
  reminder_requires_open_invoice: 'Upomínku lze připravit jen k neuhrazené potvrzené faktuře.',
};

export const outcomeMessage = (
  vm: FinanceViewModel,
  outcome: { readonly feedback: string; readonly reason: string | undefined },
) => {
  const known = Object.entries(reasonText).find(([key]) => outcome.reason?.includes(key) === true);
  return known?.[1] ?? vm.t(`finance-billing.demo.feedback.${outcome.feedback}`);
};
