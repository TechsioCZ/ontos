import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import { HttpApiMiddleware } from 'effect/unstable/httpapi';

/**
 * Wave-2 design deviation: the design places this contract at
 * `shared/portal-auth/step-up-api.ts` (design §1.4, §6). Unit U4's ownership is scoped to
 * `api/portal-auth/provider/step-up/**`, so the contract lives here instead; see the unit
 * report for the relocation the integrator (U7) should perform when adding
 * `.addHttpApi(CommercePortalAuthStepUpApi)` to `shared/api.ts` (design §2.2).
 *
 * This file is the client-facing contract — `shared/api.ts` mounts it onto
 * `commerceCustomerContextApi`, which the browser client bundle builds from. It therefore
 * declares its own wire schemas below instead of importing `./contracts.ts`: that module pulls
 * in `../config.ts` for `AttemptsRemainingSchema`'s upper bound, and `../config.ts` is the
 * server-only portal-auth configuration module (`COMMERCE_PORTAL_AUTH_SECRET`,
 * `COMMERCE_PORTAL_AUTH_DATABASE_URL`, …) — the same "declares its own schemas inline" shape
 * `shared/portal-auth/mfa-api.ts` already uses. The attempts count is left unbounded above at
 * the wire layer; the owner service is what enforces the real policy maximum before it ever
 * encodes a response, so nothing here depends on the enforced value.
 */
const CommercePortalAuthStepUpWireChallengeIdSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,200}$/u),
).pipe(Schema.brand('CommercePortalAuthStepUpChallengeId'));

const CommercePortalAuthStepUpWireAttemptsRemainingSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);

/** Mirrors `./contracts.ts`'s `CommercePortalAuthStepUpRequiredSchema` shape without its config bound. */
const CommercePortalAuthStepUpRequiredWireSchema = Schema.Struct({
  attemptsRemaining: CommercePortalAuthStepUpWireAttemptsRemainingSchema,
  challengeId: CommercePortalAuthStepUpWireChallengeIdSchema,
  expiresAt: Schema.Date,
  outcome: Schema.Literal('STEP_UP_REQUIRED'),
});

/**
 * An issue request has no caller-provided identity or policy fields. `Schema.Record(String, Never)`
 * (design §1.4's named alternative to a zero-field struct) is closed by its own shape rather than by
 * the decoder's `onExcessProperty` option: any key fails against `Schema.Never`, `{}` still decodes.
 */
const CommercePortalAuthStepUpHttpIssueBodySchema = Schema.Record(Schema.String, Schema.Never);

/** Verification accepts only the opaque challenge and the six-digit proof. */
const CommercePortalAuthStepUpHttpVerifyBodySchema = Schema.Struct({
  challengeId: CommercePortalAuthStepUpWireChallengeIdSchema,
  code: Schema.String.check(Schema.isPattern(/^[0-9]{6}$/u)),
});

export type CommercePortalAuthStepUpHttpIssueBody = typeof CommercePortalAuthStepUpHttpIssueBodySchema.Type;
export type CommercePortalAuthStepUpHttpVerifyBody = typeof CommercePortalAuthStepUpHttpVerifyBodySchema.Type;

/** Verification success carries only the outcome; the replacement session travels as a cookie. */
const CommercePortalAuthStepUpCompletedResponseSchema = Schema.Struct({
  outcome: Schema.Literal('STEP_UP_COMPLETED'),
});

export const CommercePortalAuthStepUpInvalidProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthStepUpInvalidProblem',
  400,
  { code: Schema.Literal('invalid_request') },
);
export const CommercePortalAuthStepUpRejectedProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthStepUpRejectedProblem',
  401,
  { code: Schema.Literal('step_up_rejected') },
);
export const CommercePortalAuthStepUpForbiddenProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthStepUpForbiddenProblem',
  403,
  { code: Schema.Literal('origin_not_trusted') },
);
export const CommercePortalAuthStepUpUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'CommercePortalAuthStepUpUnavailableProblem',
  503,
);

const commercePortalAuthStepUpProblems = [
  CommercePortalAuthStepUpInvalidProblemSchema,
  CommercePortalAuthStepUpRejectedProblemSchema,
  CommercePortalAuthStepUpForbiddenProblemSchema,
  CommercePortalAuthStepUpUnavailableProblemSchema,
] as const;

/**
 * Turns HttpApi's default payload-schema-decode failures (excess properties, wrong content type,
 * malformed JSON) into the same Invalid problem the handlers return, mirroring
 * `CommercePortalAuthRecoverySchemaErrorMiddleware`/`CommercePortalAuthMfaSchemaErrorMiddleware`.
 */
export class CommercePortalAuthStepUpSchemaErrorMiddleware extends HttpApiMiddleware.Service<CommercePortalAuthStepUpSchemaErrorMiddleware>()(
  'commerce-customer-context/CommercePortalAuthStepUpSchemaErrorMiddleware',
  { error: CommercePortalAuthStepUpInvalidProblemSchema },
) {}

/**
 * Standalone API contract. Mounted onto the vertical's composed API by the integrator
 * (`.addHttpApi(CommercePortalAuthStepUpApi)` in `shared/api.ts`, wave-2 design §2.2) — mirrors
 * the already-accepted `CommercePortalAuthVerificationApi` precedent.
 *
 * The endpoint chain stays a `const`. The MicroVertical API boundary checker walks a root API's
 * operands through const bindings only, so a class declaration hides the composed endpoints from
 * it. The exported group is annotated with a named type alias so its type still has a name: `shared/api.ts`
 * merges roughly a hundred group types into one `HttpApi` and declaration emit serializes that
 * union verbatim, so an anonymous group type pushes the composed contract past the compiler's
 * serialization limit (TS7056).
 *
 * The same checker reads declared routes syntactically, so each path is written as a literal
 * rather than composed from `COMMERCE_PORTAL_AUTH_INTERNAL_BASE_PATH`; each literal below is that
 * base path followed by one declared step-up route (`/step-up`, `/step-up/verify`).
 */
const commercePortalAuthStepUpGroupDefinition = HttpApiGroup.make('portalAuthStepUp')
  .add(
    HttpApiEndpoint.post('issue', '/api/portal-auth/step-up', {
      error: commercePortalAuthStepUpProblems,
      payload: CommercePortalAuthStepUpHttpIssueBodySchema,
      success: CommercePortalAuthStepUpRequiredWireSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('verify', '/api/portal-auth/step-up/verify', {
      error: commercePortalAuthStepUpProblems,
      payload: CommercePortalAuthStepUpHttpVerifyBodySchema,
      success: CommercePortalAuthStepUpCompletedResponseSchema,
    }),
  )
  .middleware(CommercePortalAuthStepUpSchemaErrorMiddleware)
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' });

export type CommercePortalAuthStepUpGroupContract = HttpApiGroup.HttpApiGroup<
  'portalAuthStepUp',
  HttpApiGroup.Endpoints<typeof commercePortalAuthStepUpGroupDefinition>
>;

const CommercePortalAuthStepUpGroup: CommercePortalAuthStepUpGroupContract = commercePortalAuthStepUpGroupDefinition;

export const CommercePortalAuthStepUpApi =
  HttpApi.make('CommercePortalAuthStepUpApi').add(CommercePortalAuthStepUpGroup);
