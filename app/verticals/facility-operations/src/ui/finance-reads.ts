// Facility operations → Finance (finance-billing) through Finance's PUBLIC governed read, with the person's own
// gateway credential (audience `finance-billing`). Finance stays the owner and enforces every permission
// server-side. The schemas below name only the fields provoz uses and decode enumerations as plain strings, so
// additive Finance contract changes (new optional fields, new states or document kinds) never break provoz
// screens. Finance commands go through Finance's generated `@app/finance-billing/clients/apply-command` client.
import { CalendarDateWireSchema, issueGatewayContext, makeOperationGateway } from '@app/shared-contracts';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Effect, Redacted, Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { financeBillingApi } from '@app/finance-billing/api';

const FINANCE_AUDIENCE = 'finance-billing' as const;
const FINANCE_API_PREFIX = '/finance-billing-api';

const FinanceResourceIdSchema = Schema.String.pipe(
  Schema.brand('FacilityFinanceResourceId'),
  Schema.decodeTo(Schema.String),
);
const FinanceActorPrincipalIdSchema = Schema.String.pipe(
  Schema.brand('FacilityFinanceActorPrincipalId'),
  Schema.decodeTo(Schema.String),
);
const RefSchema = Schema.Struct({ resourceId: FinanceResourceIdSchema });
const optionalText = Schema.optionalKey(Schema.String);

/** The invoice fields provoz reads (deadlines, overview, purchase/sales links, document options). */
export const FinanceInvoiceViewSchema = Schema.Struct({
  budgetCategory: optionalText,
  businessState: Schema.String,
  costCenter: optionalText,
  counterpartyName: optionalText,
  counterpartyRef: RefSchema,
  direction: Schema.String,
  documentNumber: Schema.String,
  dueDate: CalendarDateWireSchema,
  issueDate: CalendarDateWireSchema,
  note: optionalText,
  number: optionalText,
  paidMinor: Schema.Finite,
  paymentState: Schema.String,
  propertyRef: Schema.optionalKey(RefSchema),
  ref: RefSchema,
  sourceOrder: Schema.optionalKey(Schema.Struct({ id: Schema.String, number: Schema.String })),
  totalMinor: Schema.Finite,
  unitRef: Schema.optionalKey(RefSchema),
});
export type FinanceInvoiceView = typeof FinanceInvoiceViewSchema.Type;

export const FinanceBudgetLineViewSchema = Schema.Struct({
  actualManualMinor: Schema.optionalKey(Schema.Finite),
  category: Schema.String,
  costCenter: optionalText,
  id: Schema.String,
  kind: Schema.String,
  period: Schema.String,
  plannedMinor: Schema.Finite,
  propertyRef: Schema.optionalKey(RefSchema),
  unitRef: Schema.optionalKey(RefSchema),
});

/** A file uploaded in Finance (e.g. the supplier's invoice PDF); its bytes are read on demand. */
export const FinanceFileViewSchema = Schema.Struct({
  actorLabel: optionalText,
  actorPrincipalId: Schema.optionalKey(FinanceActorPrincipalIdSchema),
  fileName: Schema.String,
  id: Schema.String,
  invoiceResourceId: Schema.optionalKey(FinanceResourceIdSchema),
  mimeType: Schema.String,
  sizeBytes: Schema.Finite,
  uploadedAt: Schema.DateTimeUtcFromString,
});
export type FinanceFileView = typeof FinanceFileViewSchema.Type;

export const FinanceRecordsViewSchema = Schema.Struct({
  businessDate: Schema.optionalKey(CalendarDateWireSchema),
  /** Whether the person may change Finance records (create invoice drafts etc.); Finance decides. */
  canWrite: Schema.Boolean,
  document: Schema.optionalKey(
    Schema.Struct({
      contentBase64: Schema.String,
      fileName: Schema.String,
      id: Schema.String,
      mimeType: Schema.String,
    }),
  ),
  revision: Schema.Finite,
  state: Schema.Struct({
    budgets: Schema.optionalKey(Schema.Array(FinanceBudgetLineViewSchema)),
    documents: Schema.optionalKey(Schema.Array(FinanceFileViewSchema)),
    invoices: Schema.Array(FinanceInvoiceViewSchema),
  }),
});
export type FinanceRecordsView = typeof FinanceRecordsViewSchema.Type;

const FinanceDocumentIdSchema = Schema.String.pipe(
  Schema.brand('FacilityFinanceDocumentId'),
  Schema.decodeTo(Schema.String),
);
const FinanceRecordsRequestSchema = Schema.Struct({ documentId: Schema.optionalKey(FinanceDocumentIdSchema) });

const FinanceRecordsApi = HttpApi.make('FacilityOperationsFinanceRecordsApi').add(
  HttpApiGroup.make('records').add(
    HttpApiEndpoint.post('execute', '/reads/records', {
      error: [
        makeProblemDetailsSchema('RecordsInvalidProblem', 400),
        makeProblemDetailsSchema('RecordsAuthenticationProblem', 401),
        makeProblemDetailsSchema('RecordsForbiddenProblem', 403),
        makeProblemDetailsSchema('RecordsNotFoundProblem', 404),
        makeProblemDetailsSchema('RecordsPolicyConflictProblem', 409),
        makeProblemDetailsSchema('RecordsPolicyProblem', 422),
        makeRetryableProblemDetailsSchema('RecordsUnavailableProblem', 503),
        makeProblemDetailsSchema('RecordsInternalProblem', 500),
      ],
      payload: FinanceRecordsRequestSchema,
      success: FinanceRecordsViewSchema,
    }),
  ),
);

const gateway = makeOperationGateway(FINANCE_AUDIENCE, issueGatewayContext);

/** Finance records visible to the current person in the current company (Finance filters by permission). */
export const readFinance = (requestCorrelation: string, request: { readonly documentId?: string } = {}) =>
  gateway.invoke((credential, { apiBaseUrl, compositionRevision }) =>
    makeGovernedEffectBffClient(
      {
        api: FinanceRecordsApi,
        credential: Redacted.make(credential),
        defaultApiPrefix: FINANCE_API_PREFIX,
        requestCorrelation,
      },
      { baseUrl: apiBaseUrl, compositionRevision },
    ).pipe(
      Effect.flatMap((client) =>
        client.records.execute({
          payload: request.documentId === undefined ? {} : { documentId: request.documentId },
        }),
      ),
    ),
  );

/** Use Finance's published issue-date read; Tax revisions and the seller's regime stay owner-authoritative. */
export const readFinanceVatChoices = (on: string) =>
  gateway.invoke((credential, { apiBaseUrl, compositionRevision }) =>
    makeGovernedEffectBffClient(
      {
        api: financeBillingApi,
        credential: Redacted.make(credential),
        defaultApiPrefix: FINANCE_API_PREFIX,
        requestCorrelation: 'facility-operations.invoice-vat.read',
      },
      { baseUrl: apiBaseUrl, compositionRevision },
    ).pipe(Effect.flatMap((client) => client.vatChoices.execute({ payload: { on } }))),
  );

export type FinanceVatChoices = Effect.Success<ReturnType<typeof readFinanceVatChoices>>;
