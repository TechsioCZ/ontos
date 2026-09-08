// expect-count: 4
import { Schema } from 'effect';

export const GatewayContextResponseSchema = Schema.Struct({ tenantId: Schema.String });
export type GatewayContextResponse = Schema.Schema.Type<typeof GatewayContextResponseSchema>;

interface ProblemDetails {
  readonly detail: string;
  readonly status: number;
  readonly title: string;
  readonly type: string;
}

export interface GatewayAuthenticationRequiredProblem extends ProblemDetails {
  readonly _tag: 'GatewayAuthenticationRequiredProblem';
}

export interface GatewayUnavailableProblem extends ProblemDetails {
  readonly _tag: 'GatewayUnavailableProblem';
  readonly retryable: true;
}

export interface GatewayRateLimitedProblem extends ProblemDetails {
  readonly _tag: 'GatewayRateLimitedProblem';
  readonly retryAfterSeconds: number;
}

/** A string-literal key and an optional marker still declare a union member. */
export interface GatewayInternalProblem extends ProblemDetails {
  readonly '_tag'?: 'GatewayInternalProblem';
}

export type GatewayContextProblem =
  | GatewayAuthenticationRequiredProblem
  | GatewayUnavailableProblem
  | GatewayRateLimitedProblem
  | GatewayInternalProblem;
