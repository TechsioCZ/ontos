// The company owns the sender identity; deployment settings may override its address.
import { Config, ConfigProvider, Effect, Option, Schema } from 'effect';

import type { EmailEnvironment } from '../transport-runtime.ts';
import type { AgendaRecipientInput, PlannedEmail } from './contract.ts';
import { AKROS_LEGAL_ENTITY_ID, OBCHODNI_FIRMA_LEGAL_ENTITY_ID, SIAMPARK_LEGAL_ENTITY_ID } from './contract.ts';
import { companyDisplayName } from './templates.ts';

const SenderOverrideKeySchema = Schema.Literals([
  'AKROS_EMAIL_FROM',
  'OBCHODNI_FIRMA_EMAIL_FROM',
  'SIAMPARK_EMAIL_FROM',
]);
interface KnownSender {
  readonly defaultAddress: string;
  readonly displayName: string;
  readonly envKey: typeof SenderOverrideKeySchema.Type;
}
const knownSenders = new Map<string, KnownSender>([
  [
    AKROS_LEGAL_ENTITY_ID,
    { defaultAddress: 'eshop@akros.demo', displayName: 'AKROS e-shop', envKey: 'AKROS_EMAIL_FROM' },
  ],
  [
    OBCHODNI_FIRMA_LEGAL_ENTITY_ID,
    {
      defaultAddress: 'ucetni@demo.ontos',
      displayName: 'Obchodní firma – účtárna',
      envKey: 'OBCHODNI_FIRMA_EMAIL_FROM',
    },
  ],
  [
    SIAMPARK_LEGAL_ENTITY_ID,
    {
      defaultAddress: 'finance@siampark.demo',
      displayName: 'Siampark – finanční oddělení',
      envKey: 'SIAMPARK_EMAIL_FROM',
    },
  ],
]);
const DEFAULT_FALLBACK_ADDRESS = 'oznameni@ontos.demo';

/** Extract a mailbox from a display-name address, retaining the original fallback behavior. */
export const addressOf = (value: string): string | null => {
  const match =
    /<(?<address>[^<>\s]+@[^<>\s]+)>\s*$/u.exec(value) ?? /^\s*(?<address>[^<>\s]+@[^<>\s]+)\s*$/u.exec(value);
  return match?.groups?.['address'] ?? null;
};

/** Company override, then SMTP address with company display name, then the company's demo address. */
export const senderFor = Effect.fn('EmailSender.senderFor')(function* companySender(
  planned: Pick<PlannedEmail, 'legalEntityId'>,
  legalName: string | null,
  environment: EmailEnvironment,
  transport: 'cloudflare' | 'smtp' = 'smtp',
) {
  const known = knownSenders.get(planned.legalEntityId);
  const displayName = known?.displayName ?? `${companyDisplayName(legalName)} – finanční oddělení`;
  const provider = ConfigProvider.fromUnknown(environment);
  if (transport === 'cloudflare') {
    const from = yield* Config.String('ONTOS_EMAIL_FROM').pipe(Config.withDefault('')).parse(provider);
    return `${displayName} <${from}>`;
  }
  if (known !== undefined) {
    const explicit = yield* Config.schema(Schema.Trim, known.envKey).pipe(Config.option).parse(provider);
    if (Option.isSome(explicit) && explicit.value !== '') {
      return explicit.value;
    }
  }
  const smtpFrom = yield* Config.String('SMTP_FROM').pipe(Config.option).parse(provider);
  const fallback = Option.isSome(smtpFrom) ? addressOf(smtpFrom.value) : null;
  return `${displayName} <${fallback ?? known?.defaultAddress ?? DEFAULT_FALLBACK_ADDRESS}>`;
});

/** Agenda notifications have a distinct company sender, with a Siampark-specific override. */
export const agendaSenderFor = Effect.fn('EmailSender.agendaSenderFor')(function* agendaSender(
  person: Pick<AgendaRecipientInput, 'legalEntityId' | 'legalName'>,
  environment: EmailEnvironment,
  transport: 'cloudflare' | 'smtp' = 'smtp',
) {
  const provider = ConfigProvider.fromUnknown(environment);
  if (transport === 'cloudflare') {
    const from = yield* Config.String('ONTOS_EMAIL_FROM').pipe(Config.withDefault('')).parse(provider);
    return `${companyDisplayName(person.legalName)} – upozornění <${from}>`;
  }
  if (person.legalEntityId === SIAMPARK_LEGAL_ENTITY_ID) {
    const explicit = yield* Config.schema(Schema.Trim, 'SIAMPARK_AGENDA_EMAIL_FROM')
      .pipe(Config.option)
      .parse(provider);
    if (Option.isSome(explicit) && explicit.value !== '') {
      return explicit.value;
    }
  }
  const smtpFrom = yield* Config.String('SMTP_FROM').pipe(Config.option).parse(provider);
  const fallback = Option.isSome(smtpFrom) ? addressOf(smtpFrom.value) : null;
  const defaultAddress =
    person.legalEntityId === SIAMPARK_LEGAL_ENTITY_ID ? 'provoz@siampark.demo' : DEFAULT_FALLBACK_ADDRESS;
  return `${companyDisplayName(person.legalName)} – upozornění <${fallback ?? defaultAddress}>`;
});
