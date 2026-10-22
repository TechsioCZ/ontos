// @effect-diagnostics *:off
// Platform after-commit e-mail receipts. Shell staff reads are scoped to the authenticated company;
// storefront buyer reads require both the order number and its recipient. No content or address is exposed.

export const DEMO_TENANT_ID = '70000000-0000-4000-8000-000000000020';
export const AKROS_LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000024';

export type EmailDeliverySource = 'akros-order' | 'facility-agenda' | 'rent-reminder';
export type EmailDeliveryEvent =
  | 'ORDER_CREATED'
  | 'CONFIRMED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'PAYMENT_REMINDER'
  | 'AGENDA_NOTIFICATION';
/**
 * SENDING: claimed, SMTP submission in progress. SENT: SMTP server accepted DATA (250).
 * RETRY: SMTP server unreachable BEFORE any data was sent; safe to retry. FAILED: rejected permanently.
 * UNKNOWN: connection broke after DATA or the process died mid-send; never retried (never twice).
 */
export type EmailDeliveryStatus = 'SENDING' | 'SENT' | 'RETRY' | 'FAILED' | 'UNKNOWN' | 'SKIPPED';

export const emailDeliverySources: readonly EmailDeliverySource[] = ['akros-order', 'facility-agenda', 'rent-reminder'];

/**
 * E-mail provider state served on GET /shell-super-app-api/email/provider (no credentials, no cookies needed). `configured: false` when the
 * deployment sets EMAIL_PROVIDER=none: the dispatcher then sends nothing and the UI must not offer „Odeslat e-mailem“.
 */
export interface EmailProviderView {
  readonly configured: boolean;
  /** Czech one-line description, e.g. „SMTP server 127.0.0.1:1025 (Mailpit)“; null when not configured. */
  readonly label: string | null;
}

/** Result of one SMTP attempt as recorded in the ledger (status leaves SENDING exactly once per attempt). */
export type DeliveryOutcome =
  | { readonly messageId: string; readonly status: 'SENT' }
  | { readonly errorTag: string; readonly status: 'RETRY' | 'FAILED' | 'UNKNOWN' | 'SKIPPED' };

/** One e-mail derived from persisted domain state. `dedupeKey` is the never-twice identity. */
export interface PlannedEmail {
  readonly dedupeKey: string;
  readonly event: EmailDeliveryEvent;
  /** ISO-8601 UTC instant of the domain event (order created / status changed / reminder recorded). */
  readonly eventAt: string;
  /** Czech receipt label, e.g. 'Předáno dopravci' or 'Připraveno k vyzvednutí' for a pickup order. */
  readonly eventLabel: string;
  readonly html: string;
  readonly legalEntityId: string;
  readonly recipient: string;
  readonly source: EmailDeliverySource;
  readonly subject: string;
  /** Order id or reminder id. */
  readonly subjectId: string;
  /** Order number (OBJ-2026-0025) or invoice number (FV-2026-0007); '' when unknown. */
  readonly subjectNumber: string;
  readonly tenantId: string;
  readonly text: string;
}

/** Public receipt served by GET /shell-super-app-api/email/deliveries (no recipient, no content). */
export interface EmailDeliveryView {
  readonly createdAt: string;
  readonly event: EmailDeliveryEvent;
  readonly eventAt: string;
  /** Czech label of the event as e-mailed (null for rows written before labels were stored). */
  readonly eventLabel: string | null;
  /** ISO-8601 UTC instant the SMTP server accepted the message; null unless status is SENT. */
  readonly sentAt: string | null;
  readonly source: EmailDeliverySource;
  readonly status: EmailDeliveryStatus;
  readonly subjectId: string;
  readonly subjectNumber: string;
}

export interface EmailDeliveriesResponse {
  readonly deliveries: readonly EmailDeliveryView[];
}

export const emailEventLabels: Readonly<Record<EmailDeliveryEvent, string>> = {
  CANCELLED: 'Stornovaná',
  CONFIRMED: 'Zpracovává se',
  DELIVERED: 'Dokončená',
  ORDER_CREATED: 'Přijetí objednávky',
  PAYMENT_REMINDER: 'Upomínka k úhradě',
  SHIPPED: 'Předáno dopravci',
  AGENDA_NOTIFICATION: 'Upozornění z agendy',
};

export const emailStatusLabels: Readonly<Record<EmailDeliveryStatus, string>> = {
  FAILED: 'Odeslání selhalo',
  SKIPPED: 'Přeskočeno – nedoručitelná adresa příjemce',
  RETRY: 'Čeká na opakování – e-mailová služba nedostupná',
  SENDING: 'Odesílá se…',
  SENT: 'Odesláno e-mailem',
  UNKNOWN: 'Výsledek odeslání nejistý – neopakuje se',
};

export const SIAMPARK_LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000021';
export const OBCHODNI_FIRMA_LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000020';

/** Minimal read shape of a persisted AKROS order (demo_merchandise.orders document, encoded form). */
export interface AkrosOrderInput {
  readonly channel?: string;
  readonly contact?: { readonly email: string; readonly name: string; readonly phone?: string };
  /** ISO-8601 UTC. */
  readonly createdAt: string;
  readonly deliveryAddress?: {
    readonly city: string;
    readonly country?: string;
    readonly postalCode: string;
    readonly street: string;
  };
  readonly demo?: boolean;
  readonly demoCleanup?: { readonly at: string };
  readonly history?: readonly {
    readonly after?: string;
    readonly at: string;
    readonly before?: string;
    readonly kind: string;
    readonly reason?: string;
  }[];
  readonly id: string;
  readonly lines: readonly {
    readonly productName: string;
    readonly quantity: number;
    readonly sku: string;
    readonly unitPriceMinor: number;
    readonly variantName?: string;
    readonly vatRate: number;
  }[];
  readonly number: string;
  readonly pricesIncludeVat?: boolean;
  readonly shipping?: { readonly label: string; readonly method: string; readonly priceMinor: number };
  readonly status: string;
  readonly totalMinor: number;
  readonly totalVatMinor: number;
  readonly updatedAt: string;
}

/**
 * Minimal read shape of a persisted payment reminder (finance module, any company: Siampark, Obchodní firma…) plus
 * its invoice number and the legal name of the company that issued the invoice (core.legal_entities).
 */
export interface RentReminderInput {
  readonly invoiceNumber: string | null;
  readonly legalEntityId: string;
  readonly legalName: string | null;
  readonly reminder: {
    readonly createdAt: string;
    readonly deliveryMode: string;
    readonly id: string;
    readonly invoiceResourceId: string;
    readonly recipient: string;
    readonly text: string;
  };
  readonly tenantId: string;
}

/** Notification categories (facility-operations agenda). ASSIGNED and OVERDUE are mandatory, DEADLINE and CHANGE optional. */
export type AgendaNotificationCategory = 'ASSIGNED' | 'CHANGE' | 'DEADLINE' | 'OVERDUE';
export const AGENDA_MANDATORY_EMAIL_CATEGORIES: readonly AgendaNotificationCategory[] = ['ASSIGNED', 'OVERDUE'];
export const AGENDA_OPTIONAL_EMAIL_CATEGORIES: readonly AgendaNotificationCategory[] = ['DEADLINE', 'CHANGE'];

/** One persisted agenda notification (facility_operations.agenda_states, encoded JSON) of a person with a preference. */
export interface AgendaNotificationInput {
  readonly category: AgendaNotificationCategory;
  /** ISO-8601 UTC; all notifications of one delivery command share this instant (one e-mail per batch). */
  readonly createdAt: string;
  readonly detail?: string;
  readonly dueDate?: string;
  readonly href?: string;
  readonly id: string;
  readonly source: string;
  readonly title: string;
}

/** Encoded per-person preference (see facility-operations shared/domain/agenda.ts NotificationPreferenceSchema). */
export interface AgendaPreferenceInput {
  readonly emailCategories?: readonly AgendaNotificationCategory[];
  readonly emailOptIn: boolean;
  /** ISO-8601 UTC instant e-mail was switched on; older rows only have updatedAt. */
  readonly emailSince?: string;
  readonly updatedAt: string;
}

export interface AgendaRecipientInput {
  readonly email: string | null;
  readonly legalEntityId: string;
  readonly legalName: string | null;
  readonly notifications: readonly AgendaNotificationInput[];
  readonly preference: AgendaPreferenceInput;
  readonly principalId: string;
  readonly tenantId: string;
}
