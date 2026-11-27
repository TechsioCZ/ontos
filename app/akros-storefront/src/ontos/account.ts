import "server-only";
import { Effect } from "effect";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ownerRequest } from "./gateway";
import type { OperationOptions } from "@ontos/storefront-runtime";
import { getConfig } from "./config";
import type { Dictionary } from "@/i18n";
import { cs } from "@/i18n/cs";
import { RequestError } from "./http";
import { marketHref } from "./active-market";

/** Public account transport; provider internals never reach the browser. */
export type AccountSubmissionResponse =
  | { readonly outcome: string; readonly message?: never; readonly code?: never }
  | {
      readonly outcome?: never;
      readonly message: string;
      readonly code?: "verification_required";
    };

export interface CustomerAccount {
  /** Stable owner-authenticated provider subject; never accepted from a browser request body. */
  readonly id: string;
  readonly partyId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
}

const owner = "commerce-customer-context";
const base = "/api/portal-auth";

/** Forward only this realm's host-only cookies, never the staff realm or arbitrary client headers. */
export const portalCookie = (cookie: string | null): string =>
  (cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => /^(?:__Secure-)?commerce-portal\.[\w.-]+=/.test(part))
    .join("; ");

/** Response state is owned by the native incoming request, never the gateway or a render cache. */
export interface PortalRequestOptions extends OperationOptions {
  readonly responseHeaders?: Headers;
}

/** Only host-only commerce-realm cookies may leave the Portal boundary. */
export const portalSetCookies = (cookies: readonly string[]): string[] =>
  cookies.filter((cookie) => {
    const first = cookie.split(";")[0] ?? "";
    return (
      first.length > 0 &&
      portalCookie(first) === first &&
      !/[\r\n]/u.test(cookie) &&
      !/;\s*domain\s*=/iu.test(cookie)
    );
  });

export const appendPortalCookies = (headers: Headers, cookies: readonly string[]): void => {
  for (const cookie of portalSetCookies(cookies)) headers.append("set-cookie", cookie);
};

const publicPortalPath = (path: string) =>
  /^\/(?:request-password-reset|reset-password|verify-email|send-verification-email)(?:[/?]|$)/u.test(
    path,
  );
const createsPortalSession = (path: string) =>
  path === "/sign-in/email" || path === "/enrollment/start";
const revokesPortalCookie = (cookie: string) =>
  /^[^=]+=\s*(?:;|$)/u.test(cookie) || /;\s*max-age=0(?:;|$)/iu.test(cookie);

export const portalRequest = async (
  path: string,
  origin: string,
  cookie: string | null,
  body?: unknown,
  idempotencyKey?: string,
  options: PortalRequestOptions = {},
): Promise<Response> => {
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      cookie: portalCookie(cookie),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  return ownerRequest(owner, `${base}${path}`, init, {
    ...options,
    onResponse: (response) =>
      Effect.sync(() => {
        const headers = options.responseHeaders;
        if (headers === undefined || publicPortalPath(path)) return;
        const updates = portalSetCookies(response.headers.getSetCookie());
        // A sign-in/enrollment body must confirm admission before creating a session.
        // Revocations, and rotations by existing-session operations, survive body failures.
        appendPortalCookies(
          headers,
          createsPortalSession(path) ? updates.filter(revokesPortalCookie) : updates,
        );
      }),
  });
};

/** Holds the one-time reset credential between the mail link and the new-password form. Scripts cannot read it. */
export const passwordResetCookieName = "akros-password-reset";
const passwordResetMaxAge = 600;

export const passwordResetCookie = (origin: string, token: string | null): string =>
  `${passwordResetCookieName}=${token ?? ""}; Max-Age=${token === null ? 0 : passwordResetMaxAge}; Path=/; HttpOnly; SameSite=Lax${new URL(origin).protocol === "https:" ? "; Secure" : ""}`;

export const passwordResetToken = (cookie: string | null): string | null => {
  const pairs = (cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${passwordResetCookieName}=`));
  // Two copies may come from different hosts or paths. Never choose between them.
  const [pair] = pairs;
  if (pairs.length !== 1 || pair === undefined) return null;
  const token = pair.slice(passwordResetCookieName.length + 1);
  return token.length <= 2048 && /^[\w.~-]+$/u.test(token) ? token : null;
};

/** The account message for an owner status, in the request's language (`t`: `requestDictionary`). */
export const accountMessage = (t: Dictionary, status: number, code?: string): string => {
  const messages = t.server.account;
  if (code === "verification_required") return messages.verificationRequired;
  if (code === "session_limit_reached") return messages.sessionLimit;
  if (status === 401) return messages.wrongCredentials;
  if (status === 429) return messages.tooManyAttempts;
  if (status === 400) return messages.invalidInput;
  if (status === 403) return messages.refused;
  return messages.unavailable;
};

const text = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

/** Passwords are never included in an idempotency key, digest, log or browser storage. */
export const registrationInput = (input: Record<string, unknown>, t: Dictionary = cs) => {
  if (
    !text(input.firstName, 100) ||
    !input.firstName.trim() ||
    !text(input.lastName, 99) ||
    !input.lastName.trim() ||
    !text(input.email, 320) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) ||
    (input.phone !== undefined && input.phone !== "" && !text(input.phone, 100)) ||
    !text(input.password, 128) ||
    input.password.length < 12 ||
    input.password !== input.passwordConfirmation ||
    input.termsAccepted !== true
  )
    throw new RequestError(400, t.server.account.invalidRegistration);
  return {
    displayName: `${input.firstName.trim()} ${input.lastName.trim()}`.trim(),
    email: input.email.trim().toLowerCase(),
    journey: "RETAIL_SELF_ENROLLMENT",
    password: input.password,
    ...(typeof input.phone === "string" && input.phone.trim() ? { phone: input.phone.trim() } : {}),
    sellingLegalEntityId: getConfig().legalEntityId,
  };
};

/**
 * The session as Commerce sees it. "enrollment": signed in, but Commerce does not admit the person as a customer (the
 * owner answers 403: the registration is not finished yet, or admission was refused). Such a session has no customer
 * context: it sees, quotes and orders exactly as a guest does, and is offered to finish the registration; never an error.
 */
export type AccountState =
  | { readonly state: "anonymous"; readonly account: null }
  | { readonly state: "enrollment"; readonly account: null }
  | { readonly state: "authenticated"; readonly account: CustomerAccount };

export const readAccountState = async (
  origin: string,
  cookie: string | null,
  options: PortalRequestOptions = {},
): Promise<AccountState> => {
  const response = await portalRequest(
    "/customer-account",
    origin,
    cookie,
    undefined,
    undefined,
    options,
  );
  if (response.status === 401) return { state: "anonymous", account: null };
  if (response.status === 403) return { state: "enrollment", account: null };
  if (!response.ok) throw new Error("Customer account unavailable");
  const value = (await response.json()) as { state?: string; account?: CustomerAccount };
  if (value.state === "anonymous") return { state: "anonymous", account: null };
  if (
    value.state !== "authenticated" ||
    !value.account?.email ||
    !value.account.name ||
    !value.account.id ||
    !value.account.partyId ||
    !value.account.tenantId
  )
    throw new Error("Customer account response is malformed");
  return {
    state: "authenticated",
    account: {
      id: value.account.id,
      partyId: value.account.partyId,
      tenantId: value.account.tenantId,
      email: value.account.email,
      name: value.account.name,
    },
  };
};

/** The admitted customer, or null: a guest and a signed-in person Commerce does not admit have no customer context. */
export const readAccount = async (
  origin: string,
  cookie: string | null,
  options: PortalRequestOptions = {},
): Promise<CustomerAccount | null> => (await readAccountState(origin, cookie, options)).account;

/** The current server request's own origin and cookie, as the portal routes are called with them. */
export const requestPortal = async (): Promise<{ origin: string; cookie: string | null }> => {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  if (!host) throw new Error("Storefront request host is missing");
  const protocol =
    host.startsWith("localhost:") || host.startsWith("127.0.0.1:") ? "http" : "https";
  return { origin: `${protocol}://${host}`, cookie: requestHeaders.get("cookie") };
};

/** The fresh owner admission of the current server request, or null for a guest. */
export const readRequestAccount = async (
  options: PortalRequestOptions = {},
): Promise<CustomerAccount | null> => {
  const { origin, cookie } = await requestPortal();
  return readAccount(origin, cookie, options);
};

/** Server pages require a fresh owner admission. No browser-storage or email-based identity fallback. */
export const requireCustomerAccount = async (
  options: PortalRequestOptions = {},
): Promise<CustomerAccount> => {
  const { origin, cookie } = await requestPortal();
  const current = await readAccountState(origin, cookie, options);
  // Signed in with an unfinished registration: the shop offers to finish it rather than a second sign-in.
  if (current.state === "enrollment") redirect(await marketHref("/dokonceni-registrace"));
  if (current.state === "anonymous") redirect(await marketHref("/prihlaseni"));
  return current.account;
};
