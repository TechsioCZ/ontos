import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ownerRequest } from "./gateway";
import { getConfig } from "./config";
import { RequestError } from "./http";

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

export const portalRequest = (
  path: string,
  origin: string,
  cookie: string | null,
  body?: unknown,
  idempotencyKey?: string,
) =>
  ownerRequest(owner, `${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      cookie: portalCookie(cookie),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const accountMessage = (status: number, code?: string): string => {
  if (code === "verification_required")
    return "Nejprve potvrďte e-mail odkazem, který jsme vám poslali.";
  if (status === 401) return "Nesprávný e-mail nebo heslo.";
  if (status === 429) return "Příliš mnoho pokusů. Zkuste to prosím později.";
  if (status === 400) return "Zkontrolujte zadané údaje. Heslo musí mít 12 až 128 znaků.";
  if (status === 403)
    return "Účet nelze přihlásit nebo vytvořit. Zkontrolujte údaje a zkuste to znovu.";
  return "Spojení s účtem je dočasně nedostupné. Zkuste to prosím znovu.";
};

const text = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

/** Passwords are never included in an idempotency key, digest, log or browser storage. */
export const registrationInput = (input: Record<string, unknown>) => {
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
    throw new RequestError(400, "Zkontrolujte údaje, souhlas a shodu hesel (12 až 128 znaků).");
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

/** Server pages require a fresh owner admission. No browser-storage or email-based identity fallback. */
export const requireCustomerAccount = async (): Promise<CustomerAccount> => {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  if (!host) throw new Error("Storefront request host is missing");
  const protocol =
    host.startsWith("localhost:") || host.startsWith("127.0.0.1:") ? "http" : "https";
  const account = await readAccount(`${protocol}://${host}`, requestHeaders.get("cookie"));
  if (!account) redirect("/prihlaseni");
  return account;
};
