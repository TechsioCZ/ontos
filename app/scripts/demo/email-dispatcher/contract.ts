// @effect-diagnostics *:off
// Shared contract of the demo e-mail dispatcher (app/scripts/demo/email-dispatcher).
//
// The dispatcher is an after-commit worker: it reads COMMITTED domain state (AKROS storefront orders in
// demo_merchandise.merchandise_states, Siampark payment reminders in siampark_billing_finance.finance_states),
// claims each e-mail once in its own ledger table demo_email.deliveries (primary key = dedupeKey, so an
// e-mail is never sent twice) and submits it over real SMTP (Mailpit in the demo, any SMTP server via env).
// It serves read-only receipts (no recipient, no content) on http://127.0.0.1:3096/v1/deliveries.
//
// UI consumers in other packages (merchandise, siampark-billing-finance, akros-storefront) must COPY the
// view types and labels below verbatim; they must not import this file across package boundaries.

export const EMAIL_DISPATCHER_DEFAULT_PORT = 3096;
export const DEMO_TENANT_ID = '70000000-0000-4000-8000-000000000020';
export const AKROS_LEGAL_ENTITY_ID = '71000000-0000-4000-8000-000000000024';

export type EmailDeliverySource = 'akros-order' | 'siampark-reminder';
export type EmailDeliveryEvent =
  | 'ORDER_CREATED'
  | 'CONFIRMED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'PAYMENT_REMINDER';
/**
 * SENDING: claimed, SMTP submission in progress. SENT: SMTP server accepted DATA (250).
 * RETRY: SMTP server unreachable BEFORE any data was sent; safe to retry. FAILED: rejected permanently.
 * UNKNOWN: connection broke after DATA or the process died mid-send; never retried (never twice).
 */
export type EmailDeliveryStatus = 'SENDING' | 'SENT' | 'RETRY' | 'FAILED' | 'UNKNOWN';

export const emailDeliverySources: readonly EmailDeliverySource[] = ['akros-order', 'siampark-reminder'];

/** Result of one SMTP attempt as recorded in the ledger (status leaves SENDING exactly once per attempt). */
export type DeliveryOutcome =
  | { readonly messageId: string; readonly status: 'SENT' }
  | { readonly errorTag: string; readonly status: 'RETRY' | 'FAILED' | 'UNKNOWN' };

/** One e-mail derived from persisted domain state. `dedupeKey` is the never-twice identity. */
export interface PlannedEmail {
  readonly dedupeKey: string;
  readonly event: EmailDeliveryEvent;
  /** ISO-8601 UTC instant of the domain event (order created / status changed / reminder recorded). */
  readonly eventAt: string;
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

/** Public receipt served by GET /v1/deliveries (no recipient, no content). */
export interface EmailDeliveryView {
  readonly createdAt: string;
  readonly event: EmailDeliveryEvent;
  readonly eventAt: string;
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
  CONFIRMED: 'Potvrzená',
  DELIVERED: 'Dokončená',
  ORDER_CREATED: 'Přijetí objednávky',
  PAYMENT_REMINDER: 'Upomínka k úhradě',
  SHIPPED: 'Předáno dopravci',
};

export const emailStatusLabels: Readonly<Record<EmailDeliveryStatus, string>> = {
  FAILED: 'Odeslání selhalo',
  RETRY: 'Čeká na opakování – SMTP server nedostupný',
  SENDING: 'Odesílá se…',
  SENT: 'Odesláno e-mailem',
  UNKNOWN: 'Výsledek odeslání nejistý – neopakuje se',
};

/** Minimal read shape of a persisted AKROS order (demo_merchandise state JSON, encoded form). */
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

/** Minimal read shape of a persisted Siampark payment reminder plus its invoice number. */
export interface SiamparkReminderInput {
  readonly invoiceNumber: string | null;
  readonly legalEntityId: string;
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
