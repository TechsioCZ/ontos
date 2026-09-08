import { HttpApiBuilder } from '@modern-js/plugin-bff/effect-edge';
import { Schema } from 'effect';
import { partyRegistryApi } from '../shared/api.ts';
import {
  CounterpartyReadAuthenticationProblemSchema,
  CounterpartyReadForbiddenProblemSchema,
  CounterpartyReadInternalProblemSchema,
  CounterpartyReadInvalidProblemSchema,
  CounterpartyReadNotFoundProblemSchema,
  CounterpartyReadPolicyConflictProblemSchema,
  CounterpartyReadPolicyProblemSchema,
  CounterpartyReadUnavailableProblemSchema,
} from '../shared/apis/counterparty-read.ts';
import { counterpartyReadRead } from '../src/api/counterparty-read.read.ts';
import { governedReadHandler } from './governed-read-handler.ts';
import type { GovernedReadProblems } from './governed-read-handler.ts';
import { governedReadProblemStatus } from './read-server-support.ts';

const authenticationProblem = () =>
  CounterpartyReadAuthenticationProblemSchema.make({
    detail: 'A valid audience-scoped Bearer assertion is required.',
    status: governedReadProblemStatus.authentication,
    title: 'Authentication required',
    type: 'https://ontos.dev/problems/operation-authentication-required',
  });
const unavailableProblem = () =>
  CounterpartyReadUnavailableProblemSchema.make({
    detail: 'The governed read is temporarily unavailable.',
    retryable: true,
    status: governedReadProblemStatus.unavailable,
    title: 'Read unavailable',
    type: 'https://ontos.dev/problems/read-unavailable',
  });
const invalidProblem = () =>
  CounterpartyReadInvalidProblemSchema.make({
    detail: 'The governed read request is invalid.',
    status: governedReadProblemStatus.invalid,
    title: 'Invalid read request',
    type: 'https://ontos.dev/problems/read-invalid',
  });
const forbiddenProblem = () =>
  CounterpartyReadForbiddenProblemSchema.make({
    detail: 'The principal is not permitted to perform this read.',
    status: governedReadProblemStatus.forbidden,
    title: 'Read forbidden',
    type: 'https://ontos.dev/problems/read-forbidden',
  });
const notFoundProblem = () =>
  CounterpartyReadNotFoundProblemSchema.make({
    detail: 'The requested resource was not found.',
    status: governedReadProblemStatus.notFound,
    title: 'Resource not found',
    type: 'https://ontos.dev/problems/read-not-found',
  });
const policyProblem = (status: 409 | 422) =>
  status === 409
    ? CounterpartyReadPolicyConflictProblemSchema.make({
        detail: 'The read conflicts with the current business state.',
        status: governedReadProblemStatus.policyConflict,
        title: 'Read conflict',
        type: 'https://ontos.dev/problems/read-policy-conflict',
      })
    : CounterpartyReadPolicyProblemSchema.make({
        detail: 'The read is not eligible under the current business policy.',
        status: governedReadProblemStatus.policyDenied,
        title: 'Read ineligible',
        type: 'https://ontos.dev/problems/read-policy-denied',
      });
const internalProblem = () =>
  CounterpartyReadInternalProblemSchema.make({
    detail: 'The governed read could not be completed.',
    status: governedReadProblemStatus.internal,
    title: 'Read failed',
    type: 'https://ontos.dev/problems/read-failed',
  });
type ReadProblem =
  | typeof CounterpartyReadAuthenticationProblemSchema.Type
  | typeof CounterpartyReadForbiddenProblemSchema.Type
  | typeof CounterpartyReadInternalProblemSchema.Type
  | typeof CounterpartyReadInvalidProblemSchema.Type
  | typeof CounterpartyReadNotFoundProblemSchema.Type
  | typeof CounterpartyReadPolicyConflictProblemSchema.Type
  | typeof CounterpartyReadPolicyProblemSchema.Type
  | typeof CounterpartyReadUnavailableProblemSchema.Type;

const problems: GovernedReadProblems<ReadProblem> = {
  authentication: authenticationProblem,
  forbidden: forbiddenProblem,
  internal: internalProblem,
  invalid: invalidProblem,
  notFound: notFoundProblem,
  policy: policyProblem,
  unavailable: unavailableProblem,
  isAuthentication: Schema.is(CounterpartyReadAuthenticationProblemSchema),
};

export const counterpartyReadReadApiLive = HttpApiBuilder.group(
  partyRegistryApi,
  'counterpartyRead',
  (handlers) =>
    handlers.handle(
      'execute',
      governedReadHandler({
        spanName: 'counterpartyReadReadApiLive.execute',
        registration: counterpartyReadRead,
        problems,
      }),
    ),
);
