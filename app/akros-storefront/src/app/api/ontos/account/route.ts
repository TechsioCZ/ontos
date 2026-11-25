import { Effect } from "effect";
import { createOperation } from "@ontos/storefront-runtime";
import "server-only";
import {
  accountMessage,
  passwordResetCookie,
  passwordResetToken,
  appendPortalCookies,
  portalRequest,
  readAccount,
  registrationInput,
} from "@/ontos/account";
import type { AccountSubmissionResponse, PortalRequestOptions } from "@/ontos/account";
import type { Dictionary } from "@/i18n";
import {
  guard,
  jsonBody,
  problem,
  RequestError,
  requestDictionary,
  requestOrigin,
} from "@/ontos/http";

const noStore = { "cache-control": "no-store" };

/**
 * Recovery carries no browser session and is never replayed: a lost response is reported, not retried.
 * The reset credential stays in its HttpOnly cookie and is only forwarded to the owner from here.
 */
async function passwordResetSubmission(
  data: Record<string, unknown>,
  origin: string,
  cookie: string | null,
  t: Dictionary,
  options: PortalRequestOptions,
): Promise<Response> {
  if (data.operation === "request-password-reset") {
    if (
      Object.keys(data).some((key) => key !== "operation" && key !== "email") ||
      typeof data.email !== "string" ||
      data.email.trim().length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())
    )
      throw new RequestError(400, t.server.account.invalidEmail);
    const response = await portalRequest(
      "/request-password-reset",
      origin,
      null,
      {
        email: data.email.trim().toLowerCase(),
      },
      undefined,
      options,
    );
    if (!response.ok)
      return Response.json(
        { message: accountMessage(t, response.status) } satisfies AccountSubmissionResponse,
        { status: response.status, headers: noStore },
      );
    const result = (await response.json()) as { outcome?: string };
    if (result.outcome !== "ACCOUNT_RECOVERY_STARTED")
      throw new Error("Password reset request was not acknowledged");
    return Response.json({ outcome: "ACCOUNT_RECOVERY_STARTED" }, { headers: noStore });
  }
  const { newPassword, passwordConfirmation } = data;
  if (
    Object.keys(data).some(
      (key) => key !== "operation" && key !== "newPassword" && key !== "passwordConfirmation",
    ) ||
    typeof newPassword !== "string" ||
    typeof passwordConfirmation !== "string" ||
    newPassword.length < 12 ||
    newPassword.length > 128 ||
    newPassword !== passwordConfirmation
  )
    throw new RequestError(400, t.server.account.invalidInput);
  const clearCookie = { ...noStore, "set-cookie": passwordResetCookie(origin, null) };
  const token = passwordResetToken(cookie);
  if (token === null)
    return Response.json(
      { message: t.server.account.resetLinkInvalid } satisfies AccountSubmissionResponse,
      { status: 400, headers: clearCookie },
    );
  const response = await portalRequest(
    "/reset-password",
    origin,
    null,
    { newPassword, token },
    undefined,
    options,
  );
  if (response.status === 400)
    return Response.json(
      { message: t.server.account.resetLinkInvalid } satisfies AccountSubmissionResponse,
      { status: 400, headers: clearCookie },
    );
  if (!response.ok)
    return Response.json(
      { message: accountMessage(t, response.status) } satisfies AccountSubmissionResponse,
      { status: response.status, headers: noStore },
    );
  const result = (await response.json()) as { outcome?: string };
  if (result.outcome !== "ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT")
    throw new Error("Password reset was not acknowledged");
  return Response.json({ outcome: "PASSWORD_RESET_COMPLETED" }, { headers: clearCookie });
}

export async function GET(request: Request) {
  const responseHeaders = new Headers(noStore);
  const lifetime = Effect.runSync(createOperation({ signal: request.signal }));
  try {
    const account = await readAccount(requestOrigin(request), request.headers.get("cookie"), {
      operation: lifetime,
      responseHeaders,
    });
    return Response.json({ account }, { headers: responseHeaders });
  } catch (error) {
    return problem(error, accountMessage(requestDictionary(request), 503), responseHeaders);
  } finally {
    lifetime.dispose();
  }
}

export async function POST(request: Request) {
  // The JSON client owns sign-in. A native no-JS form POST must not echo or replay its credentials.
  if (
    request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") ||
    request.headers.get("content-type")?.startsWith("multipart/form-data")
  ) {
    return new Response(null, {
      status: 303,
      headers: {
        ...noStore,
        location: "/prihlaseni",
        "referrer-policy": "no-referrer",
      },
    });
  }
  const t = requestDictionary(request);
  const responseHeaders = new Headers(noStore);
  const lifetime = Effect.runSync(createOperation({ signal: request.signal }));
  try {
    guard(request, t);
    const origin = requestOrigin(request);
    if (request.headers.get("origin") !== origin)
      throw new RequestError(403, t.server.request.foreignOrigin);
    const input: unknown = await jsonBody(request, t, lifetime);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new RequestError(400, t.server.request.invalid);
    const data = input as Record<string, unknown>;
    if (data.operation === "request-password-reset" || data.operation === "reset-password")
      return await passwordResetSubmission(data, origin, request.headers.get("cookie"), t, {
        operation: lifetime,
        responseHeaders,
      });
    let path: string;
    let body: unknown;
    let idempotencyKey: string | undefined;
    if (data.operation === "register") {
      path = "/enrollment/start";
      body = registrationInput(data, t);
      if (
        typeof data.requestId !== "string" ||
        !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(data.requestId)
      )
        throw new RequestError(400, t.server.account.missingRegistrationId);
      idempotencyKey = `storefront-enrollment:${data.requestId}`;
    } else if (data.operation === "login") {
      if (
        typeof data.email !== "string" ||
        typeof data.password !== "string" ||
        data.password.length > 128
      )
        throw new RequestError(400, t.server.account.missingCredentials);
      path = "/sign-in/email";
      body = {
        email: data.email.trim().toLowerCase(),
        password: data.password,
        rememberMe: data.rememberMe === true,
      };
    } else if (data.operation === "resend-verification") {
      if (
        Object.keys(data).some((key) => key !== "operation" && key !== "email") ||
        typeof data.email !== "string" ||
        data.email.trim().length > 320 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())
      )
        throw new RequestError(400, t.server.account.invalidEmail);
      path = "/send-verification-email";
      body = { email: data.email.trim().toLowerCase() };
    } else if (data.operation === "logout") {
      path = "/sign-out";
      body = {};
    } else throw new RequestError(400, t.server.request.unknown);
    const response = await portalRequest(
      path,
      origin,
      data.operation === "resend-verification" ? null : request.headers.get("cookie"),
      body,
      idempotencyKey,
      { operation: lifetime, responseHeaders },
    );
    const result = (await response.json()) as { code?: string; outcome?: string };
    if (!response.ok)
      return Response.json(
        {
          message: accountMessage(t, response.status, result.code),
          ...(data.operation === "login" && result.code === "verification_required"
            ? { code: "verification_required" as const }
            : {}),
        } satisfies AccountSubmissionResponse,
        {
          status: response.status,
          headers: responseHeaders,
        },
      );
    if (data.operation === "resend-verification") {
      if (result.outcome !== "EMAIL_VERIFICATION_STARTED")
        throw new Error("Verification resend was not acknowledged");
      return Response.json({ outcome: "EMAIL_VERIFICATION_STARTED" }, { headers: responseHeaders });
    }
    // Never return provider subjects, session references or credentials to browser JavaScript.
    if (data.operation === "login" && result.outcome !== "SESSION_CREATED")
      return Response.json(
        { message: t.server.account.twoFactorRequired },
        { status: 403, headers: responseHeaders },
      );
    if (
      data.operation === "register" &&
      result.outcome !== "CREATED" &&
      result.outcome !== "EXISTING"
    )
      throw new Error("Enrollment start was not acknowledged");
    if (data.operation === "login" || data.operation === "register")
      appendPortalCookies(responseHeaders, response.headers.getSetCookie());
    return Response.json(
      {
        // The remaining governed owner transitions continue durably; this is not customer completion.
        outcome: data.operation === "register" ? "ENROLLMENT_STARTED" : result.outcome,
      },
      { headers: responseHeaders },
    );
  } catch (error) {
    return problem(error, accountMessage(t, 503), responseHeaders);
  } finally {
    lifetime.dispose();
  }
}
