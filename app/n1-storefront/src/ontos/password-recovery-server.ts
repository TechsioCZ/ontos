import "server-only";
import { Effect, Match, Redacted, Schema } from "effect";
import { Cookies } from "effect/http";
import type { StorefrontConfiguration } from "./config";
import { readConfiguration } from "./config";
import {
  readPasswordResetCallbackWithOwner,
  requestPasswordResetWithOwner,
  resetPasswordWithOwner,
} from "./portal-server";
import { PasswordRecoveryRequestSchema, PasswordRecoveryResetSchema } from "./password-recovery";
import type { PasswordRecoveryRequest, PasswordRecoveryReset } from "./password-recovery";

export const recoveryCookieName = "n1-password-reset";
const invalidTokenState = "invalid-token";
const TokenSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
export class PasswordRecoveryFailure extends Schema.TaggedError<PasswordRecoveryFailure>()(
  "PasswordRecoveryFailure",
  {
    state: Schema.Literals([
      "invalid",
      invalidTokenState,
      "forbidden",
      "rate-limited",
      "unavailable",
      "unconfirmed",
    ]),
  },
) {}
const tokenFromCookie = (cookie = "") => {
  const matching = cookie.split(";").filter((pair) => {
    const separator = pair.indexOf("=");
    return separator !== -1 && pair.slice(0, separator).trim() === recoveryCookieName;
  });
  // Cookie headers do not carry Domain/Path provenance. Never choose one of two credentials,
  // even when their values agree: a competing cookie could otherwise shadow the host-only one.
  return matching.length === 1 ? Cookies.parseHeader(cookie)[recoveryCookieName] : undefined;
};
/** Only the presence flag crosses the SSR boundary, never the reset credential. */
export const hasPasswordRecoveryToken = (cookie: string | undefined): boolean =>
  Schema.is(TokenSchema)(tokenFromCookie(cookie));
const configuration = () =>
  readConfiguration(process.env).pipe(
    Effect.mapError(() => new PasswordRecoveryFailure({ state: "unavailable" })),
  );
type OwnerRecoveryFailure = Effect.Error<
  | ReturnType<typeof requestPasswordResetWithOwner>
  | ReturnType<typeof resetPasswordWithOwner>
  | ReturnType<typeof readPasswordResetCallbackWithOwner>
>;
const ownerFailure = (problem: OwnerRecoveryFailure) =>
  Match.value(problem).pipe(
    Match.tag("PortalFailure", () => new PasswordRecoveryFailure({ state: "unavailable" })),
    Match.tag(
      "CommercePortalAuthRecoveryInvalidProblem",
      () => new PasswordRecoveryFailure({ state: "invalid" }),
    ),
    Match.tag(
      "CommercePortalAuthRecoveryForbiddenProblem",
      () => new PasswordRecoveryFailure({ state: "forbidden" }),
    ),
    Match.tag(
      "CommercePortalAuthRecoveryRateLimitedProblem",
      () => new PasswordRecoveryFailure({ state: "rate-limited" }),
    ),
    Match.tag(
      "CommercePortalAuthRecoveryRejectedProblem",
      (value) =>
        new PasswordRecoveryFailure({
          state: value.code === "INVALID_TOKEN" ? invalidTokenState : "invalid",
        }),
    ),
    Match.orElse(() => new PasswordRecoveryFailure({ state: "unconfirmed" })),
  );
export const requestPasswordRecoveryWithConfiguration = (
  config: StorefrontConfiguration,
  input: PasswordRecoveryRequest,
  origin: string,
) =>
  Effect.gen(function* requestPasswordRecovery() {
    const payload = yield* Schema.decodeUnknownEffect(PasswordRecoveryRequestSchema, {
      onExcessProperty: "error",
    })(input).pipe(Effect.mapError(() => new PasswordRecoveryFailure({ state: "invalid" })));
    const result = yield* requestPasswordResetWithOwner(config, payload.email, origin).pipe(
      Effect.mapError(ownerFailure),
    );
    if (result.outcome !== "ACCOUNT_RECOVERY_STARTED") {
      return yield* new PasswordRecoveryFailure({ state: "unconfirmed" });
    }
    return { state: "requested" as const };
  });
export const resetPasswordRecoveryWithConfiguration = (
  config: StorefrontConfiguration,
  input: PasswordRecoveryReset,
  cookie: string | undefined,
  origin: string,
) =>
  Effect.gen(function* resetPasswordRecovery() {
    const payload = yield* Schema.decodeUnknownEffect(PasswordRecoveryResetSchema, {
      onExcessProperty: "error",
    })(input).pipe(Effect.mapError(() => new PasswordRecoveryFailure({ state: "invalid" })));
    const token = yield* Schema.decodeUnknownEffect(TokenSchema)(tokenFromCookie(cookie)).pipe(
      Effect.mapError(() => new PasswordRecoveryFailure({ state: invalidTokenState })),
    );
    const result = yield* resetPasswordWithOwner(
      config,
      Redacted.make(payload.newPassword),
      Redacted.make(token),
      origin,
    ).pipe(Effect.mapError(ownerFailure));
    return Match.value(result.outcome).pipe(
      Match.when("ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT", () => ({
        state: "completed" as const,
      })),
      Match.when("ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED", () => ({
        state: "reconciliation" as const,
      })),
      Match.exhaustive,
    );
  });
export const acceptPasswordRecoveryWithConfiguration = (
  config: StorefrontConfiguration,
  token: string,
  callbackURL?: string,
) =>
  Effect.gen(function* acceptPasswordRecovery() {
    const checked = yield* Schema.decodeUnknownEffect(TokenSchema)(token).pipe(
      Effect.mapError(() => new PasswordRecoveryFailure({ state: invalidTokenState })),
    );
    const secret = Redacted.make(checked);
    const result = yield* readPasswordResetCallbackWithOwner(config, secret, callbackURL).pipe(
      Effect.mapError(ownerFailure),
    );
    if (result.outcome !== "PASSWORD_RESET_PENDING") {
      return yield* new PasswordRecoveryFailure({ state: invalidTokenState });
    }
    return secret;
  });
export const requestPasswordRecovery = (input: PasswordRecoveryRequest, origin: string) =>
  configuration().pipe(
    Effect.flatMap((config) => requestPasswordRecoveryWithConfiguration(config, input, origin)),
  );
export const resetPasswordRecovery = (
  input: PasswordRecoveryReset,
  cookie: string | undefined,
  origin: string,
) =>
  configuration().pipe(
    Effect.flatMap((config) =>
      resetPasswordRecoveryWithConfiguration(config, input, cookie, origin),
    ),
  );
export const acceptPasswordRecovery = (token: string, callbackURL?: string) =>
  configuration().pipe(
    Effect.flatMap((config) => acceptPasswordRecoveryWithConfiguration(config, token, callbackURL)),
  );
