import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { Effect, Schema } from 'effect';
import type { Redacted } from 'effect';
import { HttpEffect, HttpServerResponse } from 'effect/unstable/http';
import type { HttpServerRequest } from 'effect/unstable/http';

const verificationErrorFields = { reason: Schema.String };
export const OperationPrincipalVerificationErrorSchema = Schema.Union([
  Schema.TaggedStruct('ActionPrincipalConfigurationError', verificationErrorFields),
  Schema.TaggedStruct('ActionPrincipalExpiredError', verificationErrorFields),
  Schema.TaggedStruct('ActionPrincipalInvalidError', verificationErrorFields),
  Schema.TaggedStruct('ActionPrincipalMissingError', verificationErrorFields),
  Schema.TaggedStruct('ActionPrincipalScopeError', verificationErrorFields),
  Schema.TaggedStruct('ActionPrincipalUnavailableError', verificationErrorFields),
]);
export type OperationPrincipalVerificationError =
  typeof OperationPrincipalVerificationErrorSchema.Type;

export interface PrincipalAuthenticationProblems<AuthenticationProblem, UnavailableProblem> {
  readonly authentication: () => AuthenticationProblem;
  readonly unavailable: () => UnavailableProblem;
}

export type AudienceBoundOperationPrincipalVerifier<Requirements> = (
  authorization: Redacted.Redacted<string | undefined>,
) => Effect.Effect<TrustedPrincipalContext, OperationPrincipalVerificationError, Requirements>;

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);

/**
 * Binds an owner-local, audience-bound verifier to the invariant HTTP authentication behavior.
 * Endpoint call sites retain ownership of their declared public 401 and 503 values.
 */
export const makeMicroverticalHttpPrincipalAuthentication =
  <Requirements>(verify: AudienceBoundOperationPrincipalVerifier<Requirements>) =>
  <AuthenticationProblem, UnavailableProblem>(
    authorization: Redacted.Redacted<string | undefined>,
    problems: PrincipalAuthenticationProblems<AuthenticationProblem, UnavailableProblem>,
  ): Effect.Effect<
    TrustedPrincipalContext,
    AuthenticationProblem | UnavailableProblem,
    HttpServerRequest.HttpServerRequest | Requirements
  > => {
    const authentication = () =>
      bearerChallenge.pipe(Effect.andThen(Effect.fail(problems.authentication())));
    const unavailable = () => Effect.fail(problems.unavailable());
    return verify(authorization).pipe(
      Effect.catchTags({
        ActionPrincipalConfigurationError: unavailable,
        ActionPrincipalExpiredError: authentication,
        ActionPrincipalInvalidError: authentication,
        ActionPrincipalMissingError: authentication,
        ActionPrincipalScopeError: authentication,
        ActionPrincipalUnavailableError: unavailable,
      }),
    );
  };
