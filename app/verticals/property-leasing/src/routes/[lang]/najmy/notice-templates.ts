import type { Occupancy } from '../../../../shared/apis/records.ts';

export interface NoticeContext {
  readonly partyName: string;
  readonly unitLabel: string;
  readonly propertyLabel: string;
  readonly propertyAddress: string;
  readonly record: Occupancy;
}
export type NoticeChannel = 'EMAIL' | 'SMS';
export interface NoticeTemplate {
  readonly key: string;
  readonly label: string;
  readonly kinds: readonly Occupancy['kind'][];
  readonly render: (
    context: NoticeContext,
    channel: NoticeChannel,
  ) => { readonly subject: string; readonly body: string };
}

const day = (value: string) => {
  const [year, month, date] = value.split('-');
  return `${Number(date)}. ${Number(month)}. ${year}`;
};
const period = (record: Occupancy) =>
  record.endDate === null ? `od ${day(record.startDate)}` : `od ${day(record.startDate)} do ${day(record.endDate)}`;
const crowns = (minor: number) => `${(minor / 100).toLocaleString('cs-CZ')} Kč`;
const people = (count: number | null) => {
  if (count === null) return '';
  if (count === 1) return ' pro 1 osobu';
  return ` pro ${count} ${count < 5 ? 'osoby' : 'osob'}`;
};
const place = (context: NoticeContext) =>
  [context.unitLabel, context.propertyLabel].filter((part) => part.length > 0).join(', ');
const signature = '\n\nS pozdravem\nSiampark';

/**
 * Editable notification texts for stays and leases (S10). Wording is a proposal; times, prices and rules that
 * the customer has not confirmed are deliberately left out, the user completes them before sending.
 */
export const noticeTemplates: readonly NoticeTemplate[] = [
  {
    key: 'stay-confirmation',
    label: 'Potvrzení rezervace',
    kinds: ['SHORT_STAY'],
    render: (context, channel) =>
      channel === 'SMS'
        ? {
            subject: '',
            body: `Siampark: potvrzujeme rezervaci ${context.unitLabel} ${period(context.record)}${people(
              context.record.peopleCount,
            )}. Podrobnosti zašleme e-mailem.`,
          }
        : {
            subject: `Potvrzení rezervace – ${context.unitLabel}, ${period(context.record)}`,
            body: `Dobrý den, ${context.partyName},\n\npotvrzujeme Vaši rezervaci: ${place(context)}${
              context.propertyAddress.length > 0 ? ` (${context.propertyAddress})` : ''
            }, ${period(context.record)}${people(
              context.record.peopleCount,
            )}.\n\nPři příjezdu prosíme o údaje do evidenčního listu ubytovaných (jméno, datum narození, číslo dokladu a adresa).${signature}`,
          },
  },
  {
    key: 'stay-arrival',
    label: 'Pokyny k příjezdu',
    kinds: ['SHORT_STAY'],
    render: (context, channel) =>
      channel === 'SMS'
        ? {
            subject: '',
            body: `Siampark: těšíme se na Vás ${day(context.record.startDate)} v ${context.unitLabel}${
              context.propertyAddress.length > 0 ? `, ${context.propertyAddress}` : ''
            }. Čas předání klíčů upřesníme.`,
          }
        : {
            subject: `Pokyny k příjezdu – ${context.unitLabel}, ${day(context.record.startDate)}`,
            body: `Dobrý den, ${context.partyName},\n\nblíží se Váš pobyt ${period(context.record)}: ${place(context)}${
              context.propertyAddress.length > 0 ? `, ${context.propertyAddress}` : ''
            }.\n\nČas předání klíčů Vám upřesníme. Prosíme, mějte připravený doklad totožnosti pro evidenční list.${signature}`,
          },
  },
  {
    key: 'stay-cancellation',
    label: 'Zrušení rezervace',
    kinds: ['SHORT_STAY'],
    render: (context, channel) =>
      channel === 'SMS'
        ? { subject: '', body: `Siampark: Vaše rezervace ${context.unitLabel} ${period(context.record)} byla zrušena.` }
        : {
            subject: `Zrušení rezervace – ${context.unitLabel}, ${period(context.record)}`,
            body: `Dobrý den, ${context.partyName},\n\npotvrzujeme zrušení rezervace: ${place(context)}, ${period(
              context.record,
            )}.${signature}`,
          },
  },
  {
    key: 'lease-handover',
    label: 'Předání jednotky',
    kinds: ['LONG_TERM_LEASE'],
    render: (context, channel) =>
      channel === 'SMS'
        ? {
            subject: '',
            body: `Siampark: předání ${context.unitLabel} k nájmu od ${day(
              context.record.startDate,
            )}. Termín předání a protokol domluvíme.`,
          }
        : {
            subject: `Předání jednotky ${context.unitLabel} – nájem ${period(context.record)}`,
            body: `Dobrý den,\n\nk nájmu ${place(context)} ${period(
              context.record,
            )} pro ${context.partyName} připravujeme předání jednotky. Navrhněte nám prosím vhodný termín; při předání sepíšeme předávací protokol včetně stavu měřidel.${signature}`,
          },
  },
  {
    key: 'lease-payment',
    label: 'Připomenutí platby nájemného',
    kinds: ['LONG_TERM_LEASE'],
    render: (context, channel) => {
      const terms = context.record.rentTerms;
      const amount =
        terms === undefined
          ? 'sjednané nájemné'
          : `${crowns(terms.monthlyRentMinor + terms.serviceChargesMinor)} (nájemné ${crowns(
              terms.monthlyRentMinor,
            )} a zálohy ${crowns(terms.serviceChargesMinor)})`;
      const due = terms === undefined ? '' : ` se splatností ${terms.paymentDay}. dne v měsíci`;
      return channel === 'SMS'
        ? { subject: '', body: `Siampark: připomínáme platbu nájmu ${context.unitLabel}: ${amount}${due}.` }
        : {
            subject: `Platba nájemného – ${context.unitLabel}`,
            body: `Dobrý den,\n\npřipomínáme platbu za nájem ${place(context)} pro ${
              context.partyName
            }: ${amount}${due}. Pokud jste již platbu odeslali, považujte prosím tuto zprávu za bezpředmětnou.${signature}`,
          };
    },
  },
  {
    key: 'lease-end',
    label: 'Blížící se konec nájmu',
    kinds: ['LONG_TERM_LEASE'],
    render: (context, channel) => {
      const end = context.record.endDate === null ? 'není sjednán' : day(context.record.endDate);
      return channel === 'SMS'
        ? { subject: '', body: `Siampark: nájem ${context.unitLabel} končí ${end}. Ozvěte se nám k prodloužení.` }
        : {
            subject: `Konec nájmu ${context.unitLabel}`,
            body: `Dobrý den,\n\nnájem ${place(context)} pro ${
              context.partyName
            } končí ${end}. Dejte nám prosím vědět, zda máte zájem o prodloužení, nebo domluvíme termín předání.${signature}`,
          };
    },
  },
];

export const templatesFor = (kind: Occupancy['kind']) => noticeTemplates.filter((item) => item.kinds.includes(kind));
// GSM 7-bit has no Czech diacritics, so such texts travel as UCS-2 (70 characters, 67 per concatenated part).
const gsm7 = /^[A-Za-z0-9 \n\r@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà]*$/u;
export const smsSegments = (text: string) => {
  const [single, part] = gsm7.test(text) ? [160, 153] : [70, 67];
  return text.length <= single ? 1 : Math.ceil(text.length / part);
};
