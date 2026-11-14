import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { OntosError, ownerRequest } from "./gateway";
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

export const portalRequest = async (
  path: string,
  origin: string,
  cookie: string | null,
  body?: unknown,
  idempotencyKey?: string,
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
  // A transient admission read must not strand a verified login. Only these reads are safe:
  // email verification also uses GET, but consumes a one-time token and must never be replayed.
  const readOnly =
    body === undefined &&
    (path === "/customer-account" ||
      path === "/enrollment/current" ||
      path === "/customer-consent");
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await ownerRequest(owner, `${base}${path}`, init);
      if (!readOnly || response.status !== 503 || attempt >= 2) return response;
      await response.body?.cancel();
    } catch (error) {
      if (
        !readOnly ||
        !OntosError.is(error) ||
        error.status !== 503 ||
        error.code === "storefront_not_configured" ||
        attempt >= 2
      )
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
  }
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

export const readAccount = async (
  origin: string,
  cookie: string | null,
): Promise<CustomerAccount | null> => {
  const response = await portalRequest("/customer-account", origin, cookie);
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Customer account unavailable");
  const value = (await response.json()) as { state?: string; account?: CustomerAccount };
  if (value.state === "anonymous") return null;
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
    id: value.account.id,
    partyId: value.account.partyId,
    tenantId: value.account.tenantId,
    email: value.account.email,
    name: value.account.name,
  };
};

/** The fresh owner admission of the current server request, or null for a guest. */
export const readRequestAccount = async (): Promise<CustomerAccount | null> => {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  if (!host) throw new Error("Storefront request host is missing");
  const protocol =
    host.startsWith("localhost:") || host.startsWith("127.0.0.1:") ? "http" : "https";
  return readAccount(`${protocol}://${host}`, requestHeaders.get("cookie"));
};

/** Server pages require a fresh owner admission. No browser-storage or email-based identity fallback. */
export const requireCustomerAccount = async (): Promise<CustomerAccount> => {
  const account = await readRequestAccount();
  if (!account) redirect(await marketHref("/prihlaseni"));
  return account;
};
