import "server-only";
// OntOS client for the storefront BFF: the same nonhuman-principal path as tools/ontos-agent-mcp.
//   1. The first read authenticates the scoped API key and reads the owner in one Shell invocation.
//      Its private response header carries the assertion (valid 300 s) and approved apiBaseUrl. The receiving
//      gateway accepts an assertion again until it expires, so the isolate keeps one per audience and
//      composition revision in memory and mints the next one shortly before expiry.
//   2. Reads:   POST {shell}{apiBaseUrl}/reads/{readName}
//      Actions: POST {shell}{apiBaseUrl}/{vertical}/actions/{slug} with an `idempotency-key`.
// Core evaluates permissions and legal-entity scope on every call; the key is never sent to the browser.
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { getConfig } from "./config";
import { shellFetch } from "./shell-fetch";

const GATEWAY_CONTEXT_PATH = "/shell-super-app-api/auth/api-key/gateway-context";
const GATEWAY_READ_PATH = "/shell-super-app-api/auth/api-key/gateway-read";
const GATEWAY_CONTEXT_HEADER = "x-ontos-gateway-context";

export class OntosError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly body: unknown;
  constructor(message: string, status: number, code?: string, detail?: string, body?: unknown) {
    super(message);
    this.name = "OntosError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.body = body;
  }
}

interface GatewayContext {
  readonly apiBaseUrl: string;
  readonly compositionRevision: string;
  readonly token: string;
  /** Epoch ms after which this isolate stops presenting the assertion. */
  readonly reuseUntil: number;
}

/** Mint the next assertion this long before the current one expires (clock skew, slow calls). */
const ASSERTION_RENEW_MARGIN_MS = 60_000;
const ASSERTION_TTL_MS = 300_000;
// In-memory only: the isolate's assertion per audience (one storefront principal and legal entity).
const assertions = new Map<string, GatewayContext>();

/** fetch that reports an unreachable shell as a retryable 503 instead of a TypeError. */
const reach = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await shellFetch(url, init);
  } catch (error) {
    throw new OntosError(
      `OntOS unreachable: ${url.replace(/\?.*$/u, "")} (${String((error as Error).cause ?? error)})`,
      503,
      "backend_unreachable",
    );
  }
};

const credentialRequest = async (path: string, body: unknown): Promise<Response> => {
  const config = getConfig();
  if (config.apiKey === undefined) {
    throw new OntosError(
      "ONTOS_AKROS_STOREFRONT_API_KEY is not configured",
      503,
      "storefront_not_configured",
    );
  }
  return await reach(`${config.shellUrl}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "x-correlation-id": randomUUID(),
    },
    method: "POST",
    signal: AbortSignal.timeout(20_000),
  });
};

const parseProblem = (text: string): { code?: string; detail?: string; title?: string } => {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return {
      code: typeof value.code === "string" ? value.code : undefined,
      detail: typeof value.detail === "string" ? value.detail : undefined,
      title: typeof value.title === "string" ? value.title : undefined,
    };
  } catch {
    return {};
  }
};

const parseContext = (
  body: Partial<GatewayContext> & { expiresAt?: unknown },
  requestedAt: number,
): GatewayContext => {
  if (
    body === null ||
    typeof body !== "object" ||
    typeof body.apiBaseUrl !== "string" ||
    !body.apiBaseUrl.startsWith("/shell-super-app-api/") ||
    typeof body.token !== "string" ||
    body.token.length === 0 ||
    typeof body.compositionRevision !== "string" ||
    !/^[\da-f]{64}$/u.test(body.compositionRevision) ||
    typeof body.expiresAt !== "number" ||
    !Number.isSafeInteger(body.expiresAt)
  ) {
    throw new OntosError("Gateway context response is malformed", 502, "gateway_context_malformed");
  }
  return {
    apiBaseUrl: body.apiBaseUrl,
    compositionRevision: body.compositionRevision,
    token: body.token,
    reuseUntil:
      Math.min(body.expiresAt * 1000, requestedAt + ASSERTION_TTL_MS) - ASSERTION_RENEW_MARGIN_MS,
  };
};

const mintContext = async (audience: string): Promise<GatewayContext> => {
  const requestedAt = Date.now();
  const payload = { audience, legalEntityId: getConfig().legalEntityId };
  let response = await credentialRequest(GATEWAY_CONTEXT_PATH, payload);
  // A publish between release admission and issuance can reject the revision. Rebind server-side.
  if (response.status === 409 || response.status === 400) {
    await response.body?.cancel();
    response = await credentialRequest(GATEWAY_CONTEXT_PATH, payload);
  }
  const body = await parseResponse(response, GATEWAY_CONTEXT_PATH);
  return parseContext(body as Partial<GatewayContext>, requestedAt);
};

// React owns this map for one server render only. Never share pending I/O across Worker requests;
// outside a render `cache` does not retain it, so API routes keep independent request-owned mints.
const requestMints = cache(() => new Map<string, Promise<GatewayContext>>());

/** The isolate's current assertion for `audience`, minted when missing, outdated or close to expiry. */
const gatewayContext = async (audience: string): Promise<GatewayContext> => {
  const held = assertions.get(audience);
  if (held !== undefined && Date.now() < held.reuseUntil) return held;
  const pending = requestMints();
  let issuance = pending.get(audience);
  if (issuance === undefined) {
    issuance = mintContext(audience);
    pending.set(audience, issuance);
  }
  try {
    const context = await issuance;
    assertions.set(audience, context);
    return context;
  } finally {
    // A failed mint must not poison retries, nor may a rejected assertion reuse a settled promise.
    if (pending.get(audience) === issuance) pending.delete(audience);
  }
};

/** Drops a rejected or outdated assertion, so the next call mints a new one. */
const forgetContext = (audience: string, context: GatewayContext) => {
  if (assertions.get(audience)?.token === context.token) assertions.delete(audience);
};

const segment = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value))
    throw new Error(`Invalid path segment ${value}`);
  return encodeURIComponent(value);
};

const post = async (
  context: GatewayContext,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> => {
  const { shellUrl } = getConfig();
  const correlationId = randomUUID();
  const response = await reach(`${shellUrl}${context.apiBaseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${context.token}`,
      "content-type": "application/json",
      "x-correlation-id": correlationId,
      "x-ontos-composition-revision": context.compositionRevision,
      ...headers,
    },
    method: "POST",
    signal: AbortSignal.timeout(20_000),
  });
  return await parseResponse(response, path);
};

const parseResponse = async (response: Response, path: string): Promise<unknown> => {
  const text = await response.text();
  if (!response.ok) {
    const problem = parseProblem(text);
    console.error(
      `[ontos] ${path} -> HTTP ${response.status} ${problem.code ?? ""} (correlation ${response.headers.get("x-correlation-id") ?? "missing"})`,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    throw new OntosError(
      `OntOS ${path} failed: HTTP ${response.status} ${problem.code ?? ""}`.trim(),
      response.status,
      problem.code,
      problem.detail ?? problem.title,
      parsed,
    );
  }
  return JSON.parse(text) as unknown;
};

/** Governed records read of a vertical (the isolate's assertion for that vertical). */
export const readRecords = async (
  vertical: string,
  readName: string,
  query: unknown,
): Promise<unknown> => {
  // Reads are safe to repeat: ride out a shell/vertical restart (503) or a just-published composition (409).
  for (let attempt = 0; ; attempt += 1) {
    try {
      let firstResponse: Response | undefined;
      const path = `/reads/${segment(readName)}`;
      // A combined gateway-read returns the assertion only after its owner finishes. Waiting for another
      // read's issuance would serialize otherwise independent owner reads (category + recommendations).
      // Cold reads therefore each authenticate and dispatch in parallel; only settled assertions are reused.
      const held = assertions.get(vertical);
      const context =
        held !== undefined && Date.now() < held.reuseUntil
          ? held
          : await (async () => {
              const requestedAt = Date.now();
              firstResponse = await credentialRequest(GATEWAY_READ_PATH, {
                audience: vertical,
                legalEntityId: getConfig().legalEntityId,
                readName: segment(readName),
                query,
              });
              const encoded = firstResponse.headers.get(GATEWAY_CONTEXT_HEADER);
              if (encoded === null) {
                if (!firstResponse.ok) await parseResponse(firstResponse, path);
                throw new OntosError(
                  "Gateway read response has no assertion",
                  502,
                  "gateway_context_malformed",
                );
              }
              let decoded: Partial<GatewayContext>;
              try {
                decoded = JSON.parse(encoded) as Partial<GatewayContext>;
              } catch {
                throw new OntosError(
                  "Gateway context response is malformed",
                  502,
                  "gateway_context_malformed",
                );
              }
              const issued = parseContext(decoded, requestedAt);
              assertions.set(vertical, issued);
              return issued;
            })();
      try {
        return firstResponse === undefined
          ? await post(context, path, query)
          : await parseResponse(firstResponse, path);
      } catch (error) {
        if (error instanceof OntosError && [400, 401, 403, 409].includes(error.status))
          forgetContext(vertical, context);
        throw error;
      }
    } catch (error) {
      const retryable =
        error instanceof OntosError &&
        (error.status === 503 ||
          error.status === 409 ||
          error.status === 400 ||
          error.status === 502 ||
          error.status === 401) &&
        error.code !== "storefront_not_configured";
      if (!retryable || attempt >= 2) throw error;
      // A rejected assertion is replaced at once; an unavailable backend gets a short pause.
      if (error.status !== 401)
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
};

/** Owner HTTP surface reached through the same scoped, governed Shell gateway as Actions. */
export const ownerRequest = async (
  vertical: string,
  path: string,
  init: RequestInit,
): Promise<Response> => {
  if (!path.startsWith("/api/") || path.includes("..")) throw new Error("Invalid owner path");
  // Enrollment redeems its assertion once for its composed Actions. Never lend it an assertion
  // held by another request (or retry a credential-carrying request after an unknown outcome).
  const context = await mintContext(vertical);
  return reach(`${getConfig().shellUrl}${context.apiBaseUrl}${path}`, {
    ...init,
    cache: "no-store",
    redirect: "manual",
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      authorization: `Bearer ${context.token}`,
      "x-correlation-id": randomUUID(),
      "x-ontos-composition-revision": context.compositionRevision,
    },
    signal: AbortSignal.timeout(30_000),
  });
};

/** Governed action. `idempotencyKey` must be reused verbatim (with the identical payload) on retries. */
export const callAction = async (
  vertical: string,
  actionSlug: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<unknown> => {
  const context = await gatewayContext(vertical);
  try {
    return await post(context, `/${segment(vertical)}/actions/${segment(actionSlug)}`, payload, {
      "idempotency-key": idempotencyKey,
    });
  } catch (error) {
    if (error instanceof OntosError && [400, 401, 403, 409].includes(error.status))
      forgetContext(vertical, context);
    throw error;
  }
};
