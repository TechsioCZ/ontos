import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { Schema } from 'effect';

import type { AdmitSymmyJobRejected } from './symmy-job-admission.ts';

const RouteDeniedProblemSchema = makeProblemDetailsSchema('AdmitSymmyJobRouteDeniedProblem', 403, {
  code: Schema.Literal('symmy_job_route_denied'),
});
const IntentConflictProblemSchema = makeProblemDetailsSchema('AdmitSymmyJobIntentConflictProblem', 409, {
  code: Schema.Literal('symmy_job_intent_conflict'),
});
const PersistenceUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'AdmitSymmyJobPersistenceUnavailableProblem',
  503,
  { code: Schema.Literal('symmy_job_persistence_unavailable') },
);

export const AdmitSymmyJobBusinessProblemSchema = Schema.Union([
  RouteDeniedProblemSchema,
  IntentConflictProblemSchema,
  PersistenceUnavailableProblemSchema,
]);

const problems = {
  symmy_job_intent_conflict: IntentConflictProblemSchema.make({
    code: 'symmy_job_intent_conflict',
    detail: 'The idempotency key is already bound to a different accepted intent.',
    status: IntentConflictProblemSchema.fields.status.literal,
    title: 'Integration job intent conflict',
    type: 'https://ontos.dev/problems/symmy-job-intent-conflict',
  }),
  symmy_job_persistence_unavailable: PersistenceUnavailableProblemSchema.make({
    code: 'symmy_job_persistence_unavailable',
    detail: 'The integration job could not be admitted.',
    retryable: true,
    status: PersistenceUnavailableProblemSchema.fields.status.literal,
    title: 'Integration job unavailable',
    type: 'https://ontos.dev/problems/symmy-job-unavailable',
  }),
  symmy_job_route_denied: RouteDeniedProblemSchema.make({
    code: 'symmy_job_route_denied',
    detail: 'This integration job is not authorized for the current route.',
    status: RouteDeniedProblemSchema.fields.status.literal,
    title: 'Integration route denied',
    type: 'https://ontos.dev/problems/symmy-job-route-denied',
  }),
} as const;

export const mapAdmitSymmyJobBusinessProblem = ({ code }: AdmitSymmyJobRejected) => problems[code];
