// Siampark provoz → Finance (siampark-billing-finance) through Finance's PUBLIC governed read and action, with the
// person's own gateway credential (audience `siampark-billing-finance`). Finance stays the owner and enforces every
// permission server-side. The schemas below name only the fields provoz uses and decode enumerations as plain
// strings, so additive Finance contract changes (new optional fields, new states or document kinds) never break
// provoz screens. Commands are still encoded with Finance's own command schema.
import { ApplyCommandPayloadSchema } from '@app/siampark-billing-finance/contracts/apply-command';
import type { ApplyCommandPayload } from '@app/siampark-billing-finance/contracts/apply-command';
import { issueGatewayContext, makeOperationGateway } from '@app/shared-contracts';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Effect, Redacted, Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

const FINANCE_AUDIENCE = 'siampark-billing-finance' as const;
const FINANCE_API_PREFIX = '/siampark-billing-finance-api';

const RefSchema = Schema.Struct({ resourceId: Schema.String });
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
  dueDate: Schema.String,
  issueDate: Schema.String,
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
export type FinanceBudgetLineView = typeof FinanceBudgetLineViewSchema.Type;

/** A file uploaded in Finance (e.g. the supplier's invoice PDF); its bytes are read on demand. */
export const FinanceFileViewSchema = Schema.Struct({
  actorLabel: optionalText,
  actorPrincipalId: optionalText,
  fileName: Schema.String,
  id: Schema.String,
  invoiceResourceId: optionalText,
  mimeType: Schema.String,
  sizeBytes: Schema.Finite,
  uploadedAt: Schema.String,
});
export type FinanceFileView = typeof FinanceFileViewSchema.Type;

export const FinanceRecordsViewSchema = Schema.Struct({
  businessDate: optionalText,
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

const FinanceRecordsRequestSchema = Schema.Struct({ documentId: optionalText });

const problemCode = { code: Schema.optionalKey(Schema.String) };

const FinanceRecordsApi = HttpApi.make('SiamparkOpsFinanceRecordsApi').add(
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

/** Result of a Finance command as provoz needs it; the invoice is the stored one (number, id, total). */
export const FinanceCommandResultViewSchema = Schema.Struct({
  changed: Schema.optionalKey(Schema.Boolean),
  invoice: Schema.optionalKey(
    Schema.Struct({
      documentNumber: Schema.String,
      number: optionalText,
      ref: RefSchema,
      totalMinor: Schema.Finite,
    }),
  ),
  revision: Schema.Finite,
});

const FinanceApplyCommandApi = HttpApi.make('SiamparkOpsFinanceApplyCommandApi').add(
  HttpApiGroup.make('applyCommand').add(
    HttpApiEndpoint.post('execute', '/siampark-billing-finance/actions/apply-command', {
      error: [
        makeProblemDetailsSchema('ApplyCommandActionInvalidProblem', 400, problemCode),
        makeProblemDetailsSchema('ApplyCommandActionAuthenticationProblem', 401, problemCode),
        makeProblemDetailsSchema('ApplyCommandActionForbiddenProblem', 403, problemCode),
        makeProblemDetailsSchema('ApplyCommandActionNotFoundProblem', 404, problemCode),
        makeProblemDetailsSchema('ApplyCommandActionConflictProblem', 409, problemCode),
        makeProblemDetailsSchema('ApplyCommandActionAlreadyCommittedProblem', 409, problemCode),
        makeProblemDetailsSchema('ApplyCommandActionIneligibleProblem', 422, problemCode),
        makeProblemDetailsSchema('ApplyCommandActionPreconditionProblem', 428, problemCode),
        makeRetryableProblemDetailsSchema('ApplyCommandActionUnavailableProblem', 503, problemCode),
        makeProblemDetailsSchema('ApplyCommandActionCommitIndeterminateProblem', 503, problemCode),
        makeProblemDetailsSchema('ApplyCommandActionInternalProblem', 500, problemCode),
      ],
      payload: Schema.toEncoded(ApplyCommandPayloadSchema),
      success: FinanceCommandResultViewSchema,
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

/** Runs one Finance command as the current person; Finance rejects it (403) when the role may not write. */
export const applyFinanceCommand = (
  payload: ApplyCommandPayload,
  requestCorrelation: string,
  options: { readonly idempotencyKey: string; readonly referenceCredentials?: Redacted.Redacted },
) =>
  gateway.invoke((credential, { apiBaseUrl, compositionRevision }) =>
    Schema.encodeUnknownEffect(ApplyCommandPayloadSchema)(payload).pipe(
      Effect.flatMap((encoded) =>
        makeGovernedEffectBffClient(
          {
            api: FinanceApplyCommandApi,
            credential: Redacted.make(credential),
            defaultApiPrefix: FINANCE_API_PREFIX,
            idempotencyKey: options.idempotencyKey,
            requestCorrelation,
          },
          {
            baseUrl: apiBaseUrl,
            compositionRevision,
            ...(options.referenceCredentials === undefined
              ? {}
              : { referenceCredentials: options.referenceCredentials }),
          },
        ).pipe(Effect.flatMap((client) => client.applyCommand.execute({ payload: encoded }))),
      ),
    ),
  );
