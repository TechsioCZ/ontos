// @effect-diagnostics *:off
// Sender (From) of each e-mail: always the company the e-mail is about, configurable per company via env.
import type { AgendaRecipientInput, PlannedEmail } from './contract.ts';
import { AKROS_LEGAL_ENTITY_ID, OBCHODNI_FIRMA_LEGAL_ENTITY_ID, SIAMPARK_LEGAL_ENTITY_ID } from './contract.ts';
import { companyDisplayName } from './templates.ts';

interface KnownSender {
  readonly defaultAddress: string;
  readonly displayName: string;
  readonly envKey: string;
}

/** Demo companies with their own sender. Any other company sends as „<legal name> – finanční oddělení“. */
const knownSenders: Readonly<Record<string, KnownSender>> = {
  [AKROS_LEGAL_ENTITY_ID]: {
    defaultAddress: 'eshop@akros.demo',
    displayName: 'AKROS e-shop',
    envKey: 'AKROS_EMAIL_FROM',
  },
  [OBCHODNI_FIRMA_LEGAL_ENTITY_ID]: {
    defaultAddress: 'ucetni@demo.ontos',
    displayName: 'Obchodní firma – účtárna',
    envKey: 'OBCHODNI_FIRMA_EMAIL_FROM',
  },
  [SIAMPARK_LEGAL_ENTITY_ID]: {
    defaultAddress: 'finance@siampark.demo',
    displayName: 'Siampark – finanční oddělení',
    envKey: 'SIAMPARK_EMAIL_FROM',
  },
};

const DEFAULT_FALLBACK_ADDRESS = 'oznameni@ontos.demo';

/** `Name <a@b.cz>` or `a@b.cz` → `a@b.cz`; null when no address is present. */
export const addressOf = (value: string): string | null => {
  const match = /<([^<>\s]+@[^<>\s]+)>\s*$/u.exec(value) ?? /^\s*([^<>\s]+@[^<>\s]+)\s*$/u.exec(value);
  return match?.[1] ?? null;
};

/**
 * Precedence: the company's own variable (AKROS_EMAIL_FROM, SIAMPARK_EMAIL_FROM, OBCHODNI_FIRMA_EMAIL_FROM) →
 * SMTP_FROM's address with the company's display name → the built-in demo address of the company.
 */
export const senderFor = (
  planned: Pick<PlannedEmail, 'legalEntityId'>,
  legalName: string | null,
  env: Readonly<Record<string, string | undefined>>,
  transport: 'cloudflare' | 'smtp' = 'smtp',
): string => {
  const known = knownSenders[planned.legalEntityId];
  if (transport === 'cloudflare') {
    const name = known?.displayName ?? `${companyDisplayName(legalName)} – finanční oddělení`;
    return `${name} <${env['ONTOS_EMAIL_FROM'] ?? ''}>`;
  }
  const explicit = known === undefined ? undefined : env[known.envKey]?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;
  const displayName = known?.displayName ?? `${companyDisplayName(legalName)} – finanční oddělení`;
  const fallback = env['SMTP_FROM'] === undefined ? null : addressOf(env['SMTP_FROM']);
  return `${displayName} <${fallback ?? known?.defaultAddress ?? DEFAULT_FALLBACK_ADDRESS}>`;
};

/** Agenda notifications: „<company> – upozornění <address>“; SIAMPARK_AGENDA_EMAIL_FROM overrides it for Siampark. */
export const agendaSenderFor = (
  person: Pick<AgendaRecipientInput, 'legalEntityId' | 'legalName'>,
  env: Readonly<Record<string, string | undefined>>,
  transport: 'cloudflare' | 'smtp' = 'smtp',
): string => {
  if (transport === 'cloudflare')
    return `${companyDisplayName(person.legalName)} – upozornění <${env['ONTOS_EMAIL_FROM'] ?? ''}>`;
  const explicit =
    person.legalEntityId === SIAMPARK_LEGAL_ENTITY_ID ? env['SIAMPARK_AGENDA_EMAIL_FROM']?.trim() : undefined;
  if (explicit !== undefined && explicit !== '') return explicit;
  const fallback = env['SMTP_FROM'] === undefined ? null : addressOf(env['SMTP_FROM']);
  const defaultAddress =
    person.legalEntityId === SIAMPARK_LEGAL_ENTITY_ID ? 'provoz@siampark.demo' : DEFAULT_FALLBACK_ADDRESS;
  return `${companyDisplayName(person.legalName)} – upozornění <${fallback ?? defaultAddress}>`;
};
