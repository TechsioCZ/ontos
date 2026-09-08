import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { Schema } from 'effect';
import { partyRegistryApi } from '../shared/api.ts';
import {
  PartyMergeReadinessAuthenticationProblemSchema,
  PartyMergeReadinessForbiddenProblemSchema,
  PartyMergeReadinessInternalProblemSchema,
  PartyMergeReadinessInvalidProblemSchema,
  PartyMergeReadinessNotFoundProblemSchema,
  PartyMergeReadinessPolicyConflictProblemSchema,
  PartyMergeReadinessPolicyProblemSchema,
  PartyMergeReadinessUnavailableProblemSchema,
} from '../shared/apis/party-merge-readiness.ts';
import { partyMergeReadinessRead } from '../src/api/party-merge-readiness.read.ts';
import { governedReadHandler } from './governed-read-handler.ts';
import type { GovernedReadProblems } from './governed-read-handler.ts';
import { governedReadProblemStatus } from './read-server-support.ts';

const authenticationProblem = () =>
  PartyMergeReadinessAuthenticationProblemSchema.make({
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: governedReadProblemStatus.authentication,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  });
const unavailableProblem = () =>
  PartyMergeReadinessUnavailableProblemSchema.make({
    detail: 'The governed read is temporarily unavailable.',
    retryable: true,
    status: governedReadProblemStatus.unavailable,
    title: 'Read unavailable',
    type: 'https://ontos.dev/problems/read-unavailable',
  });
const invalidProblem = () =>
  PartyMergeReadinessInvalidProblemSchema.make({
    detail: 'The governed read request is invalid.',
    status: governedReadProblemStatus.invalid,
    title: 'Invalid read request',
    type: 'https://ontos.dev/problems/read-invalid',
  });
const forbiddenProblem = () =>
  PartyMergeReadinessForbiddenProblemSchema.make({
    detail: 'The principal is not permitted to perform this read.',
    status: governedReadProblemStatus.forbidden,
    title: 'Read forbidden',
    type: 'https://ontos.dev/problems/read-forbidden',
  });
const notFoundProblem = () =>
  PartyMergeReadinessNotFoundProblemSchema.make({
    detail: 'The requested resource was not found.',
    status: governedReadProblemStatus.notFound,
    title: 'Resource not found',
    type: 'https://ontos.dev/problems/read-not-found',
  });
const policyProblem = (status: 409 | 422) =>
  status === 409
    ? PartyMergeReadinessPolicyConflictProblemSchema.make({
        detail: 'The read conflicts with the current business state.',
        status: governedReadProblemStatus.policyConflict,
        title: 'Read conflict',
        type: 'https://ontos.dev/problems/read-policy-conflict',
      })
    : PartyMergeReadinessPolicyProblemSchema.make({
        detail: 'The read is not eligible under the current business policy.',
        status: governedReadProblemStatus.policyDenied,
        title: 'Read ineligible',
        type: 'https://ontos.dev/problems/read-policy-denied',
      });
const internalProblem = () =>
  PartyMergeReadinessInternalProblemSchema.make({
    detail: 'The governed read could not be completed.',
    status: governedReadProblemStatus.internal,
    title: 'Read failed',
    type: 'https://ontos.dev/problems/read-failed',
  });
type ReadProblem =
  | typeof PartyMergeReadinessAuthenticationProblemSchema.Type
  | typeof PartyMergeReadinessForbiddenProblemSchema.Type
  | typeof PartyMergeReadinessInternalProblemSchema.Type
  | typeof PartyMergeReadinessInvalidProblemSchema.Type
  | typeof PartyMergeReadinessNotFoundProblemSchema.Type
  | typeof PartyMergeReadinessPolicyConflictProblemSchema.Type
  | typeof PartyMergeReadinessPolicyProblemSchema.Type
  | typeof PartyMergeReadinessUnavailableProblemSchema.Type;

const problems: GovernedReadProblems<ReadProblem> = {
  authentication: authenticationProblem,
  forbidden: forbiddenProblem,
  internal: internalProblem,
  invalid: invalidProblem,
  notFound: notFoundProblem,
  policy: policyProblem,
  unavailable: unavailableProblem,
  isAuthentication: Schema.is(PartyMergeReadinessAuthenticationProblemSchema),
};

export const partyMergeReadinessReadApiLive = HttpApiBuilder.group(
  partyRegistryApi,
  'partyMergeReadiness',
  (handlers) =>
    handlers.handle(
      'execute',
      governedReadHandler({
        spanName: 'partyMergeReadinessReadApiLive.execute',
        registration: partyMergeReadinessRead,
        problems,
      }),
    ),
);
