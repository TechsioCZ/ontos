import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { Schema } from 'effect';
import { partyRegistryApi } from '../shared/api.ts';
import {
  PartyCorrectionAuthenticationProblemSchema,
  PartyCorrectionForbiddenProblemSchema,
  PartyCorrectionInternalProblemSchema,
  PartyCorrectionInvalidProblemSchema,
  PartyCorrectionNotFoundProblemSchema,
  PartyCorrectionPolicyConflictProblemSchema,
  PartyCorrectionPolicyProblemSchema,
  PartyCorrectionUnavailableProblemSchema,
} from '../shared/apis/party-correction.ts';
import { partyCorrectionRead } from '../src/api/party-correction.read.ts';
import { governedReadHandler } from './governed-read-handler.ts';
import type { GovernedReadProblems } from './governed-read-handler.ts';
import { governedReadProblemStatus } from './read-server-support.ts';

const authenticationProblem = () =>
  PartyCorrectionAuthenticationProblemSchema.make({
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: governedReadProblemStatus.authentication,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  });
const unavailableProblem = () =>
  PartyCorrectionUnavailableProblemSchema.make({
    detail: 'The governed read is temporarily unavailable.',
    retryable: true,
    status: governedReadProblemStatus.unavailable,
    title: 'Read unavailable',
    type: 'https://ontos.dev/problems/read-unavailable',
  });
const invalidProblem = () =>
  PartyCorrectionInvalidProblemSchema.make({
    detail: 'The governed read request is invalid.',
    status: governedReadProblemStatus.invalid,
    title: 'Invalid read request',
    type: 'https://ontos.dev/problems/read-invalid',
  });
const forbiddenProblem = () =>
  PartyCorrectionForbiddenProblemSchema.make({
    detail: 'The principal is not permitted to perform this read.',
    status: governedReadProblemStatus.forbidden,
    title: 'Read forbidden',
    type: 'https://ontos.dev/problems/read-forbidden',
  });
const notFoundProblem = () =>
  PartyCorrectionNotFoundProblemSchema.make({
    detail: 'The requested resource was not found.',
    status: governedReadProblemStatus.notFound,
    title: 'Resource not found',
    type: 'https://ontos.dev/problems/read-not-found',
  });
const policyProblem = (status: 409 | 422) =>
  status === 409
    ? PartyCorrectionPolicyConflictProblemSchema.make({
        detail: 'The read conflicts with the current business state.',
        status: governedReadProblemStatus.policyConflict,
        title: 'Read conflict',
        type: 'https://ontos.dev/problems/read-policy-conflict',
      })
    : PartyCorrectionPolicyProblemSchema.make({
        detail: 'The read is not eligible under the current business policy.',
        status: governedReadProblemStatus.policyDenied,
        title: 'Read ineligible',
        type: 'https://ontos.dev/problems/read-policy-denied',
      });
const internalProblem = () =>
  PartyCorrectionInternalProblemSchema.make({
    detail: 'The governed read could not be completed.',
    status: governedReadProblemStatus.internal,
    title: 'Read failed',
    type: 'https://ontos.dev/problems/read-failed',
  });
type ReadProblem =
  | typeof PartyCorrectionAuthenticationProblemSchema.Type
  | typeof PartyCorrectionForbiddenProblemSchema.Type
  | typeof PartyCorrectionInternalProblemSchema.Type
  | typeof PartyCorrectionInvalidProblemSchema.Type
  | typeof PartyCorrectionNotFoundProblemSchema.Type
  | typeof PartyCorrectionPolicyConflictProblemSchema.Type
  | typeof PartyCorrectionPolicyProblemSchema.Type
  | typeof PartyCorrectionUnavailableProblemSchema.Type;

const problems: GovernedReadProblems<ReadProblem> = {
  authentication: authenticationProblem,
  forbidden: forbiddenProblem,
  internal: internalProblem,
  invalid: invalidProblem,
  notFound: notFoundProblem,
  policy: policyProblem,
  unavailable: unavailableProblem,
  isAuthentication: Schema.is(PartyCorrectionAuthenticationProblemSchema),
};

export const partyCorrectionReadApiLive = HttpApiBuilder.group(
  partyRegistryApi,
  'partyCorrection',
  (handlers) =>
    handlers.handle(
      'execute',
      governedReadHandler({
        spanName: 'partyCorrectionReadApiLive.execute',
        registration: partyCorrectionRead,
        problems,
      }),
    ),
);
