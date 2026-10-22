// @effect-diagnostics *:off
import type { AgendaNotificationInput, AkrosOrderInput, RentReminderInput } from './contract.ts';
import { SIAMPARK_LEGAL_ENTITY_ID } from './contract.ts';

export type AkrosOrderEmailEvent = 'ORDER_CREATED' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';

export interface RenderedEmail {
  readonly html: string;
  readonly subject: string;
  readonly text: string;
}

export const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export const formatCzk = (minor: number): string =>
  `${(minor / 100).toLocaleString('cs-CZ', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} Kč`;

export const lineGrossMinor = (order: AkrosOrderInput, line: AkrosOrderInput['lines'][number]): number =>
  Math.round(line.quantity * line.unitPriceMinor * (order.pricesIncludeVat === true ? 1 : 1 + line.vatRate / 100));

const layout = (brand: string, color: string, title: string, bodyHtml: string, footerHtml: string): string =>
  `<!doctype html><html lang="cs"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
  `<body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">` +
  `<div style="max-width:600px;margin:0 auto;background:#ffffff;padding:24px">` +
  `<div style="font-size:22px;font-weight:bold;color:${color};margin-bottom:16px">${escapeHtml(brand)}</div>` +
  `<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(title)}</h1>${bodyHtml}` +
  `<hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0"><div style="font-size:12px;color:#52525b">${footerHtml}</div></div></body></html>`;

const statusLabels: Readonly<Record<AkrosOrderEmailEvent, string>> = {
  ORDER_CREATED: 'Nová',
  CONFIRMED: 'Zpracovává se',
  SHIPPED: 'Předáno dopravci',
  DELIVERED: 'Dokončená',
  CANCELLED: 'Stornovaná',
};

const demoNote =
  'Ukázkové prostředí OntOS (DEMO): tento e-mail byl skutečně odeslán přes SMTP, ale zboží se nevychystává, ' +
  'nepředává dopravci ani nedoručuje a nic se neplatí.';

/** Personal pickup: the SHIPPED transition means „ready for pickup“, never „handed to a carrier“. */
export const isPickupOrder = (order: AkrosOrderInput): boolean => order.shipping?.method === 'OSOBNI_ODBER';

/** Customer-facing shipping label: the staff-side „(simulace)“ marker is covered by the DEMO footer instead. */
export const customerShippingLabel = (order: AkrosOrderInput): string =>
  (order.shipping?.label ?? 'doprava dle objednávky').replace(/\s*\(simulace\)\s*$/u, '').trim() ||
  'doprava dle objednávky';

/** Czech receipt label of one e-mailed event (shown next to „Odesláno e-mailem“ in the shop and staff app). */
export const orderEventLabel = (order: AkrosOrderInput, event: AkrosOrderEmailEvent): string => {
  switch (event) {
    case 'ORDER_CREATED':
      return 'Přijetí objednávky';
    case 'CONFIRMED':
      return 'Zpracovává se';
    case 'SHIPPED':
      return isPickupOrder(order) ? 'Připraveno k vyzvednutí' : 'Předáno dopravci';
    case 'DELIVERED':
      return 'Dokončená';
    case 'CANCELLED':
      return 'Stornovaná';
  }
};

const subjectOf = (event: AkrosOrderEmailEvent, number: string, pickup: boolean): string => {
  switch (event) {
    case 'ORDER_CREATED':
      return `AKROS – přijali jsme vaši objednávku ${number}`;
    case 'CONFIRMED':
      return `AKROS – objednávka ${number} se zpracovává`;
    case 'SHIPPED':
      return pickup
        ? `AKROS – objednávka ${number} je připravena k vyzvednutí`
        : `AKROS – objednávka ${number} byla předána dopravci`;
    case 'DELIVERED':
      return `AKROS – objednávka ${number} je dokončená`;
    case 'CANCELLED':
      return `AKROS – objednávka ${number} byla stornována`;
  }
};

const leadOf = (event: AkrosOrderEmailEvent, number: string, shippingLabel: string, pickup: boolean): string => {
  switch (event) {
    case 'ORDER_CREATED':
      return `Děkujeme za vaši objednávku č. ${number}. Přijali jsme ji a předali ke zpracování.`;
    case 'CONFIRMED':
      return `Vaši objednávku č. ${number} jsme přijali ke zpracování a připravujeme ji k expedici.`;
    case 'SHIPPED':
      return pickup
        ? `Objednávka č. ${number} je připravena k vyzvednutí (${shippingLabel}).`
        : `Objednávku č. ${number} jsme předali dopravci (${shippingLabel}).`;
    case 'DELIVERED':
      return `Objednávka č. ${number} je dokončená. Děkujeme za nákup.`;
    case 'CANCELLED':
      return `Objednávka č. ${number} byla stornována.`;
  }
};

export const akrosOrderEmail = (
  order: AkrosOrderInput,
  event: AkrosOrderEmailEvent,
  options: { readonly reason?: string; readonly storefrontUrl: string },
): RenderedEmail => {
  const number = order.number;
  const pickup = isPickupOrder(order);
  const shippingLabel = customerShippingLabel(order);
  const subject = subjectOf(event, number, pickup);
  const reason = options.reason;
  const reasonSuffix = event === 'CANCELLED' && reason !== undefined && reason !== '' ? ` Důvod: ${reason}` : '';
  const lead = `${leadOf(event, number, shippingLabel, pickup)}${reasonSuffix}`;
  const status = event === 'SHIPPED' && pickup ? 'Připraveno k vyzvednutí' : statusLabels[event];
  const lines = order.lines.map((line) => {
    const hasVariant = line.variantName !== undefined && line.variantName !== '';
    return {
      name: hasVariant ? `${line.productName} – ${line.variantName}` : line.productName,
      quantity: line.quantity.toLocaleString('cs-CZ'),
      price: formatCzk(lineGrossMinor(order, line)),
    };
  });
  const shippingPrice = formatCzk(order.shipping?.priceMinor ?? 0);
  const total = formatCzk(order.totalMinor);
  const vat = formatCzk(order.totalVatMinor);
  const address = order.deliveryAddress;
  const storefrontUrl = options.storefrontUrl;

  const text = [
    'Dobrý den,',
    lead,
    `Aktuální stav: ${status}`,
    ['Shrnutí objednávky', ...lines.map((l) => `${l.name}\nMnožství: ${l.quantity}\n${l.price}`)].join('\n\n'),
    `Doprava – ${shippingLabel}: ${shippingPrice}\nCelkem vč. DPH: ${total}\nz toho DPH: ${vat}`,
    ...(address !== undefined ? [`Doručovací adresa\n${address.street}\n${address.postalCode} ${address.city}`] : []),
    'S pozdravem\nTým e-shopu AKROS',
    `${demoNote}\nObchod AKROS: ${storefrontUrl}`,
  ].join('\n\n');

  const rows = lines
    .map(
      (l) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #f4f4f5">${escapeHtml(l.name)}</td>` +
        `<td style="padding:8px 0;border-bottom:1px solid #f4f4f5;text-align:right">${escapeHtml(l.quantity)}</td>` +
        `<td style="padding:8px 0;border-bottom:1px solid #f4f4f5;text-align:right">${escapeHtml(l.price)}</td></tr>`,
    )
    .join('');
  const body =
    `<p>Dobrý den,</p>` +
    `<p>${escapeHtml(lead)}</p>` +
    `<p>Aktuální stav: <strong>${escapeHtml(status)}</strong></p>` +
    `<h2 style="font-size:15px;margin:24px 0 8px">Shrnutí objednávky</h2>` +
    `<table style="width:100%;border-collapse:collapse;font-size:14px">` +
    `<thead><tr>` +
    `<th style="text-align:left;padding:6px 0;border-bottom:1px solid #e4e4e7">Položka</th>` +
    `<th style="text-align:right;padding:6px 0;border-bottom:1px solid #e4e4e7">Množství</th>` +
    `<th style="text-align:right;padding:6px 0;border-bottom:1px solid #e4e4e7">Cena</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `<p style="margin:12px 0 0">Doprava – ${escapeHtml(shippingLabel)}: ${escapeHtml(shippingPrice)}<br>` +
    `Celkem vč. DPH: <strong>${escapeHtml(total)}</strong><br>` +
    `z toho DPH: ${escapeHtml(vat)}</p>` +
    (address !== undefined
      ? `<h2 style="font-size:15px;margin:24px 0 8px">Doručovací adresa</h2>` +
        `<p>${escapeHtml(address.street)}<br>${escapeHtml(address.postalCode)} ${escapeHtml(address.city)}</p>`
      : '') +
    `<p>S pozdravem<br>Tým e-shopu AKROS</p>`;
  const footer =
    `<p style="margin:0 0 8px">${escapeHtml(demoNote)}</p>` +
    `<p style="margin:0">Obchod AKROS: <a href="${escapeHtml(storefrontUrl)}">${escapeHtml(storefrontUrl)}</a></p>`;

  return { subject, text, html: layout('AKROS', '#c8102e', subject, body, footer) };
};

/** Display name of the issuing company: legal name without the „(demo)“ suffix. */
export const companyDisplayName = (legalName: string | null): string =>
  (legalName ?? '').replace(/\s*\(demo\)\s*$/iu, '').trim() || 'Finanční oddělení';

/** Payment reminder in the name of the company that issued the invoice (Siampark, Obchodní firma, …). */
export const rentReminderEmail = (input: RentReminderInput): RenderedEmail => {
  const company = companyDisplayName(input.legalName);
  const invoiceNumber = input.invoiceNumber;
  const subject =
    invoiceNumber !== null && invoiceNumber !== ''
      ? `${company} – upomínka k faktuře ${invoiceNumber}`
      : `${company} – upomínka k neuhrazené faktuře`;
  const footerText = `Ukázkové prostředí OntOS (DEMO): e-mail odeslán přes SMTP z finančního modulu OntOS jménem společnosti ${company}.`;
  const text = `${input.reminder.text}\n\n—\n${footerText}`;
  const paragraphs = input.reminder.text
    .split(/\n{2,}/u)
    .map((paragraph) => `<p style="margin:0 0 12px">${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
    .join('');
  const color = input.legalEntityId === SIAMPARK_LEGAL_ENTITY_ID ? '#0f766e' : '#1e3a8a';
  return { subject, text, html: layout(company, color, subject, paragraphs, escapeHtml(footerText)) };
};

/** Same wording as the in-app notification centre (facility-operations locales agenda.json „inbox.category“). */
export const agendaCategoryLabels: Readonly<Record<AgendaNotificationInput['category'], string>> = {
  ASSIGNED: 'Přiřazeno vám',
  CHANGE: 'Změna',
  DEADLINE: 'Blíží se termín',
  OVERDUE: 'Po termínu',
};

const czechDate = (iso: string): string => {
  const [year, month, day] = iso.slice(0, 10).split('-');
  return `${Number(day)}. ${Number(month)}. ${year}`;
};

/** One e-mail per delivery batch (all notifications one person received at the same instant) from the agenda. */
export const agendaNotificationEmail = (input: {
  readonly appUrl: string;
  readonly legalName: string | null;
  readonly notifications: readonly AgendaNotificationInput[];
}): RenderedEmail => {
  const company = companyDisplayName(input.legalName);
  const items = input.notifications;
  const first = items[0];
  const count = items.length;
  const plural = count === 1 ? 'nové upozornění' : count < 5 ? 'nová upozornění' : 'nových upozornění';
  const subject =
    count === 1 && first !== undefined
      ? `${company} – ${agendaCategoryLabels[first.category].toLowerCase()}: ${first.title}`
      : `${company} – ${count} ${plural} v agendě`;
  const linkOf = (item: AgendaNotificationInput) => `${input.appUrl}/cs${item.href ?? '/provoz/agenda?tab=notifikace'}`;
  const lineOf = (item: AgendaNotificationInput) =>
    [
      `${agendaCategoryLabels[item.category]}: ${item.title}`,
      ...(item.detail === undefined ? [] : [item.detail]),
      ...(item.dueDate === undefined ? [] : [`Termín: ${czechDate(item.dueDate)}`]),
      `Otevřít: ${linkOf(item)}`,
    ].join('\n');
  const footerText =
    `Ukázkové prostředí OntOS (DEMO): e-mail odeslán přes SMTP z agendy OntOS (${company}), protože máte v nastavení ` +
    'upozornění zapnuté posílání e-mailem. Změnit to můžete v Moje agenda → Nastavení upozornění.';
  const agendaUrl = `${input.appUrl}/cs/provoz/agenda`;
  const text = [
    'Dobrý den,',
    count === 1 ? 'v agendě máte nové upozornění:' : `v agendě máte ${count} ${plural}:`,
    ...items.map(lineOf),
    `Všechna upozornění: ${agendaUrl}`,
    `—\n${footerText}`,
  ].join('\n\n');
  const rows = items
    .map(
      (item) =>
        `<li style="margin:0 0 12px"><strong>${escapeHtml(agendaCategoryLabels[item.category])}:</strong> ` +
        `<a href="${escapeHtml(linkOf(item))}">${escapeHtml(item.title)}</a>` +
        (item.detail === undefined ? '' : `<br><span style="color:#52525b">${escapeHtml(item.detail)}</span>`) +
        (item.dueDate === undefined ? '' : `<br>Termín: ${escapeHtml(czechDate(item.dueDate))}`) +
        `</li>`,
    )
    .join('');
  const body =
    `<p>Dobrý den,</p><p>${escapeHtml(count === 1 ? 'v agendě máte nové upozornění:' : `v agendě máte ${count} ${plural}:`)}</p>` +
    `<ul style="padding-left:20px">${rows}</ul>` +
    `<p><a href="${escapeHtml(agendaUrl)}">Otevřít Moje agenda</a></p>`;
  return { subject, text, html: layout(company, '#0f766e', subject, body, escapeHtml(footerText)) };
};
