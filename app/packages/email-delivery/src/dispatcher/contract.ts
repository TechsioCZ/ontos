// Platform after-commit e-mail receipts. Shell staff reads are scoped to the authenticated company;
// storefront buyer reads require both the order number and its recipient. No content or address is exposed.

import { CalendarDateSchema } from '@app/shared-contracts';
import { Schema } from 'effect';

export { isTestRecipient } from './recipients.ts';

export const DEMO_TENANT_ID = '70000000-0000-4000-8000-000000000020';
export const AKROS_LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000024';

export const EmailDeliverySourceSchema = Schema.Literals([
  'akros-order',
  'facility-agenda',
  'rent-reminder',
  'storefront-inquiry',
  'person-invitation',
]);
export type EmailDeliverySource = typeof EmailDeliverySourceSchema.Type;
export const emailDeliverySources = EmailDeliverySourceSchema.literals;

export const EmailDeliveryEventSchema = Schema.Literals([
  'ORDER_CREATED',
  'CONFIRMED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'PAYMENT_REMINDER',
  'AGENDA_NOTIFICATION',
  'INQUIRY_RECEIVED',
  'PERSON_INVITED',
]);
export type EmailDeliveryEvent = typeof EmailDeliveryEventSchema.Type;
export const emailDeliveryEvents = EmailDeliveryEventSchema.literals;
/**
 * SENDING: claimed, SMTP submission in progress. SENT: SMTP server accepted DATA (250).
 * RETRY: SMTP server unreachable BEFORE any data was sent; safe to retry. FAILED: rejected permanently.
 * UNKNOWN: connection broke after DATA or the process died mid-send; never retried (never twice).
 */
export const EmailDeliveryStatusSchema = Schema.Literals(['SENDING', 'SENT', 'RETRY', 'FAILED', 'UNKNOWN', 'SKIPPED']);
export type EmailDeliveryStatus = typeof EmailDeliveryStatusSchema.Type;
export const emailDeliveryStatuses = EmailDeliveryStatusSchema.literals;

const TenantIdSchema = Schema.String.pipe(Schema.brand('EmailDeliveryTenantId'));
const LegalEntityIdSchema = Schema.String.pipe(Schema.brand('EmailDeliveryLegalEntityId'));
const SubjectIdSchema = Schema.String.pipe(Schema.brand('EmailDeliverySubjectId'));

/**
 * E-mail provider state served on GET /shell-super-app-api/email/provider (no credentials, no cookies needed). `configured: false` when the
 * deployment sets EMAIL_PROVIDER=none: the dispatcher then sends nothing and the UI must not offer „Odeslat e-mailem“.
 */
export const EmailProviderViewSchema = Schema.Struct({
  configured: Schema.Boolean,
  /** Czech provider description; null on the wire when not configured. */
  label: Schema.OptionFromNullOr(Schema.String),
});
export type EmailProviderView = typeof EmailProviderViewSchema.Encoded;

/** Result of one SMTP attempt as recorded in the ledger. */
export const DeliveryOutcomeSchema = Schema.Union([
  Schema.Struct({
    messageId: Schema.String.pipe(Schema.brand('EmailProviderMessageId')),
    status: Schema.Literal('SENT'),
  }),
  Schema.Struct({
    errorTag: Schema.String,
    status: EmailDeliveryStatusSchema.pick(['RETRY', 'FAILED', 'UNKNOWN', 'SKIPPED']),
  }),
]);
export type DeliveryOutcome = typeof DeliveryOutcomeSchema.Encoded;

/** Encoded message derived from persisted state. `dedupeKey` is the never-twice identity. */
export const PlannedEmailSchema = Schema.Struct({
  dedupeKey: Schema.String.pipe(Schema.brand('EmailDeliveryDedupeKey')),
  event: EmailDeliveryEventSchema,
  eventAt: Schema.DateTimeUtcFromString,
  eventLabel: Schema.String,
  html: Schema.RedactedFromValue(Schema.String),
  legalEntityId: LegalEntityIdSchema,
  recipient: Schema.RedactedFromValue(Schema.String),
  source: EmailDeliverySourceSchema,
  subject: Schema.String,
  subjectId: SubjectIdSchema,
  /** Order or invoice number; an empty string means unknown. */
  subjectNumber: Schema.String,
  tenantId: TenantIdSchema,
  text: Schema.RedactedFromValue(Schema.String),
});
export type PlannedEmail = typeof PlannedEmailSchema.Encoded;

/** Public acceptance receipt. No recipient, content or provider identifier can be serialized. */
export const EmailDeliveryViewSchema = Schema.Struct({
  createdAt: Schema.DateTimeUtcFromString,
  event: EmailDeliveryEventSchema,
  eventAt: Schema.DateTimeUtcFromString,
  /** Older rows encode an absent label as null. */
  eventLabel: Schema.OptionFromNullOr(Schema.String),
  /** SMTP acceptance instant; null unless the message is SENT. */
  sentAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  source: EmailDeliverySourceSchema,
  status: EmailDeliveryStatusSchema,
  subjectId: SubjectIdSchema,
  subjectNumber: Schema.String,
});
/** SQL rows retain the encoded receipt shape. Public clients decode the owning schema. */
export type EmailDeliveryView = typeof EmailDeliveryViewSchema.Encoded;

export const EmailDeliveriesResponseSchema = Schema.Struct({
  deliveries: Schema.Array(EmailDeliveryViewSchema),
});
export type EmailDeliveriesResponse = typeof EmailDeliveriesResponseSchema.Encoded;

export const emailEventLabels = {
  AGENDA_NOTIFICATION: 'Upozornění z agendy',
  CANCELLED: 'Stornovaná',
  CONFIRMED: 'Zpracovává se',
  DELIVERED: 'Dokončená',
  INQUIRY_RECEIVED: 'Nový dotaz z e-shopu',
  ORDER_CREATED: 'Přijetí objednávky',
  PAYMENT_REMINDER: 'Upomínka k úhradě',
  PERSON_INVITED: 'Pozvánka do OntOS',
  SHIPPED: 'Předáno dopravci',
} as const satisfies Readonly<Record<EmailDeliveryEvent, string>>;

export const emailStatusLabels = {
  FAILED: 'Odeslání selhalo',
  RETRY: 'Čeká na opakování – e-mailová služba nedostupná',
  SENDING: 'Odesílá se…',
  SENT: 'Odesláno e-mailem',
  SKIPPED: 'Přeskočeno – nedoručitelná adresa příjemce',
  UNKNOWN: 'Výsledek odeslání nejistý – neopakuje se',
} as const satisfies Readonly<Record<EmailDeliveryStatus, string>>;

export const SIAMPARK_LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000021';
export const OBCHODNI_FIRMA_LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000020';

/** Minimal read shape of a persisted AKROS order (demo_merchandise.orders document, encoded form). */
export const AkrosOrderInputSchema = Schema.Struct({
  channel: Schema.optionalKey(Schema.String),
  contact: Schema.optionalKey(
    Schema.Struct({
      email: Schema.RedactedFromValue(Schema.String),
      name: Schema.String,
      phone: Schema.optionalKey(Schema.String),
    }),
  ),
  createdAt: Schema.DateTimeUtcFromString,
  deliveryAddress: Schema.optionalKey(
    Schema.Struct({
      city: Schema.String,
      country: Schema.optionalKey(Schema.String),
      postalCode: Schema.String,
      street: Schema.String,
    }),
  ),
  demo: Schema.optionalKey(Schema.Boolean),
  demoCleanup: Schema.optionalKey(Schema.Struct({ at: Schema.DateTimeUtcFromString })),
  history: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        after: Schema.optionalKey(Schema.String),
        at: Schema.DateTimeUtcFromString,
        before: Schema.optionalKey(Schema.String),
        kind: Schema.String,
        reason: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  id: Schema.String.pipe(Schema.brand('EmailOrderId')),
  lines: Schema.Array(
    Schema.Struct({
      productName: Schema.String,
      quantity: Schema.Finite,
      sku: Schema.String,
      unitPriceMinor: Schema.Finite,
      variantName: Schema.optionalKey(Schema.String),
      vatRate: Schema.Finite,
    }),
  ),
  number: Schema.String,
  pricesIncludeVat: Schema.optionalKey(Schema.Boolean),
  shipping: Schema.optionalKey(
    Schema.Struct({
      label: Schema.String,
      method: Schema.String,
      priceMinor: Schema.Finite,
    }),
  ),
  status: Schema.String,
  totalMinor: Schema.Finite,
  totalVatMinor: Schema.Finite,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type AkrosOrderInput = typeof AkrosOrderInputSchema.Encoded;

/** Encoded reminder plus its issuer and invoice number, read from persisted finance state. */
export const RentReminderInputSchema = Schema.Struct({
  invoiceNumber: Schema.OptionFromNullOr(Schema.String),
  legalEntityId: LegalEntityIdSchema,
  legalName: Schema.OptionFromNullOr(Schema.String),
  reminder: Schema.Struct({
    createdAt: Schema.DateTimeUtcFromString,
    deliveryMode: Schema.String,
    id: Schema.String.pipe(Schema.brand('EmailRentReminderId')),
    invoiceResourceId: Schema.String.pipe(Schema.brand('EmailInvoiceId')),
    recipient: Schema.RedactedFromValue(Schema.String),
    text: Schema.RedactedFromValue(Schema.String),
  }),
  tenantId: TenantIdSchema,
});
export type RentReminderInput = typeof RentReminderInputSchema.Encoded;

/** ASSIGNED and OVERDUE are mandatory; DEADLINE and CHANGE are optional. */
export const AgendaNotificationCategorySchema = Schema.Literals(['ASSIGNED', 'CHANGE', 'DEADLINE', 'OVERDUE']);
export type AgendaNotificationCategory = typeof AgendaNotificationCategorySchema.Type;
export const AGENDA_MANDATORY_EMAIL_CATEGORIES = AgendaNotificationCategorySchema.pick([
  'ASSIGNED',
  'OVERDUE',
]).literals;
export const AGENDA_OPTIONAL_EMAIL_CATEGORIES = AgendaNotificationCategorySchema.pick(['DEADLINE', 'CHANGE']).literals;

/** Encoded notifications of one person; equal createdAt values form one e-mail batch. */
export const AgendaNotificationInputSchema = Schema.Struct({
  category: AgendaNotificationCategorySchema,
  createdAt: Schema.DateTimeUtcFromString,
  detail: Schema.optionalKey(Schema.String),
  dueDate: Schema.optionalKey(CalendarDateSchema),
  href: Schema.optionalKey(Schema.String),
  id: Schema.String.pipe(Schema.brand('EmailAgendaNotificationId')),
  source: Schema.String,
  title: Schema.String,
});
export type AgendaNotificationInput = typeof AgendaNotificationInputSchema.Encoded;

/** Optional keys preserve older persisted preference snapshots. */
export const AgendaPreferenceInputSchema = Schema.Struct({
  emailCategories: Schema.optionalKey(Schema.Array(AgendaNotificationCategorySchema)),
  emailOptIn: Schema.Boolean,
  emailSince: Schema.optionalKey(Schema.DateTimeUtcFromString),
  updatedAt: Schema.DateTimeUtcFromString,
});
export type AgendaPreferenceInput = typeof AgendaPreferenceInputSchema.Encoded;

export const AgendaRecipientInputSchema = Schema.Struct({
  email: Schema.OptionFromNullOr(Schema.RedactedFromValue(Schema.String)),
  legalEntityId: LegalEntityIdSchema,
  legalName: Schema.OptionFromNullOr(Schema.String),
  notifications: Schema.Array(AgendaNotificationInputSchema),
  preference: AgendaPreferenceInputSchema,
  principalId: Schema.String.pipe(Schema.brand('EmailAgendaPrincipalId')),
  tenantId: TenantIdSchema,
});
export type AgendaRecipientInput = typeof AgendaRecipientInputSchema.Encoded;

/** Persisted actionable task intake; no marketing consent or price/stock snapshot. */
export const StorefrontInquiryTaskSchema = Schema.Struct({
  createdAt: Schema.DateTimeUtcFromString,
  ref: Schema.Struct({ resourceId: Schema.String.pipe(Schema.brand('StorefrontInquiryTaskId')) }),
  storefrontInquiry: Schema.Struct({
    email: Schema.String,
    kind: Schema.Literals(['CONTACT', 'PRODUCT_QUESTION', 'COMPLAINT']),
    message: Schema.String,
    name: Schema.String,
    productId: Schema.optionalKey(Schema.String.pipe(Schema.brand('StorefrontInquiryProductId'))),
    productName: Schema.optionalKey(Schema.String),
    productSlug: Schema.optionalKey(Schema.String),
    requestId: Schema.String.pipe(Schema.brand('StorefrontInquiryRequestId')),
    subject: Schema.String,
  }),
  title: Schema.String,
});
export type StorefrontInquiryTaskInput = typeof StorefrontInquiryTaskSchema.Encoded;
