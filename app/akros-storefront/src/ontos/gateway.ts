import "server-only";
// OntOS client for the storefront BFF: the same nonhuman-principal path as tools/ontos-agent-mcp.
//   Reads authenticate the scoped API key and read the owner in one Shell invocation.
//   Actions mint their own assertion, then POST to the approved owner URL with an `idempotency-key`.
//   Gateway assertions are single-use, including the one already redeemed by a combined read.
//   Never cache or share them between invocations, even within the same server render.
// Core evaluates permissions and legal-entity scope on every call; the key is never sent to the browser.
import { randomUUID } from "node:crypto";
import { getConfig } from "./config";
import { shellFetch } from "./shell-fetch";

const GATEWAY_CONTEXT_PATH = "/shell-super-app-api/auth/api-key/gateway-context";
const GATEWAY_READ_PATH = "/shell-super-app-api/auth/api-key/gateway-read";
const GATEWAY_CONTEXT_HEADER = "x-ontos-gateway-context";

export class OntosError extends Error {
  static is(value: unknown): value is OntosError {
    return value !== null && value !== undefined && OntosError.prototype.isPrototypeOf(value);
  }

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
}

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

const parseContext = (body: Partial<GatewayContext> & { expiresAt?: unknown }): GatewayContext => {
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
  };
};

const mintContext = async (audience: string): Promise<GatewayContext> => {
  const payload = { audience, legalEntityId: getConfig().legalEntityId };
  let response = await credentialRequest(GATEWAY_CONTEXT_PATH, payload);
  // A publish between release admission and issuance can reject the revision. Rebind server-side.
  if (response.status === 409 || response.status === 400) {
    await response.body?.cancel();
    response = await credentialRequest(GATEWAY_CONTEXT_PATH, payload);
  }
  const body = await parseResponse(response, GATEWAY_CONTEXT_PATH);
  return parseContext(body as Partial<GatewayContext>);
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

/** Governed records read, with a fresh assertion issued and redeemed inside the combined gateway. */
export const readRecords = async (
  vertical: string,
  readName: string,
  query: unknown,
): Promise<unknown> => {
  // Reads are safe to repeat: ride out a shell/vertical restart (503) or a just-published composition (409).
  for (let attempt = 0; ; attempt += 1) {
    try {
      const path = `/reads/${segment(readName)}`;
      const response = await credentialRequest(GATEWAY_READ_PATH, {
        audience: vertical,
        legalEntityId: getConfig().legalEntityId,
        readName: segment(readName),
        query,
      });
      const encoded = response.headers.get(GATEWAY_CONTEXT_HEADER);
      if (encoded === null) {
        if (!response.ok) await parseResponse(response, path);
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
      parseContext(decoded);
      return await parseResponse(response, path);
    } catch (error) {
      const retryable =
        OntosError.is(error) &&
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
  const context = await mintContext(vertical);
  return await post(context, `/${segment(vertical)}/actions/${segment(actionSlug)}`, payload, {
    "idempotency-key": idempotencyKey,
  });
};
