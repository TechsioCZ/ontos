// Open sales cases (obchodní případy) for the Siampark overview, read through the sales-pipeline PUBLIC governed read
// with the person's own gateway credential (audience `sales-pipeline`). The schema below names only the fields the
// overview uses, so newer producer fields never break this read.
import { issueGatewayContext, makeOperationGateway } from '@app/shared-contracts';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Effect, Redacted, Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

const SalesStageSchema = Schema.String;

export const SalesCaseSchema = Schema.Struct({
  amountMinor: Schema.Int,
  archivedAt: Schema.optionalKey(Schema.String),
  expectedCloseDate: Schema.String,
  id: Schema.String,
  partyId: Schema.String,
  probability: Schema.Int,
  stage: SalesStageSchema,
  title: Schema.String,
});
export type SalesCase = typeof SalesCaseSchema.Type;

const SalesRecordsSchema = Schema.Struct({ items: Schema.Array(SalesCaseSchema) });

const SalesApi = HttpApi.make('FacilityOperationsSalesCasesApi').add(
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
      payload: Schema.Struct({}),
      success: SalesRecordsSchema,
    }),
  ),
);

const gateway = makeOperationGateway('sales-pipeline', issueGatewayContext);

/** Every opportunity of the current company the person may read (the producer filters by permission). */
export const loadSalesCases = (requestCorrelation: string) =>
  gateway.invoke((credential, { apiBaseUrl, compositionRevision }) =>
    makeGovernedEffectBffClient(
      {
        api: SalesApi,
        credential: Redacted.make(credential),
        defaultApiPrefix: '/sales-pipeline-api',
        requestCorrelation,
      },
      { baseUrl: apiBaseUrl, compositionRevision },
    ).pipe(Effect.flatMap((client) => client.records.execute({ payload: {} }))),
  );

export const isOpenSalesCase = (entry: SalesCase) =>
  entry.archivedAt === undefined && entry.stage !== 'WON' && entry.stage !== 'LOST';
