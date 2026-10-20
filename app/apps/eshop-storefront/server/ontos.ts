// OntOS client for the storefront BFF: the same nonhuman-principal path as tools/ontos-agent-mcp.
//   1. POST {shell}/shell-super-app-api/auth/api-key/gateway-context  (x-api-key, audience, legalEntityId)
//      -> short-lived bearer assertion + apiBaseUrl of the vertical on the shell origin.
//   2. Reads:   POST {shell}{apiBaseUrl}/reads/{readName}
//      Actions: POST {shell}{apiBaseUrl}/{vertical}/actions/{slug} with an `idempotency-key`.
// Core evaluates permissions and legal-entity scope on every call; the key is never sent to the browser.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getConfig } from './config.ts';

const GATEWAY_CONTEXT_PATH = '/shell-super-app-api/auth/api-key/gateway-context';

export class OntosError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly body: unknown;
  constructor(message: string, status: number, code?: string, detail?: string, body?: unknown) {
    super(message);
    this.name = 'OntosError';
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

let liveRevision: string | undefined;

const requestSignal = (timeout: number, deadline?: AbortSignal): AbortSignal =>
  deadline === undefined ? AbortSignal.timeout(timeout) : AbortSignal.any([deadline, AbortSignal.timeout(timeout)]);

const fetchActiveRevision = async (deadline?: AbortSignal): Promise<string | undefined> => {
  try {
    const response = await fetch(getConfig().compositionUrl, { signal: requestSignal(4000, deadline) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { composition?: { revision?: unknown } };
    const revision = body.composition?.revision;
    if (typeof revision === 'string' && /^[\da-f]{64}$/u.test(revision)) {
      liveRevision = revision;
      return revision;
    }
  } catch {
    // publisher down: the caller reports an unavailable backend
  }
  return undefined;
};

/** fetch that reports an unreachable shell as a retryable 503 instead of a TypeError. */
const reach = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new OntosError(`OntOS unreachable: ${url.replace(/\?.*$/u, '')} (${String((error as Error).cause ?? error)})`, 503, 'backend_unreachable');
  }
};

const responseText = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch {
    throw new OntosError('OntOS response interrupted', 503, 'backend_unreachable');
  }
};

const requestContext = async (audience: string, revision: string, deadline?: AbortSignal): Promise<Response> => {
  const config = getConfig();
  return await reach(`${config.shellUrl}${GATEWAY_CONTEXT_PATH}`, {
    body: JSON.stringify({ audience, compositionRevision: revision, legalEntityId: config.legalEntityId }),
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey ?? '',
      'x-correlation-id': randomUUID(),
    },
    method: 'POST',
    signal: requestSignal(10_000, deadline),
  });
};

const parseProblem = (text: string): { code?: string; detail?: string; title?: string } => {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return {
      code: typeof value.code === 'string' ? value.code : undefined,
      detail: typeof value.detail === 'string' ? value.detail : undefined,
      title: typeof value.title === 'string' ? value.title : undefined,
    };
  } catch {
    return {};
  }
};

const gatewayContext = async (audience: string, deadline?: AbortSignal): Promise<GatewayContext> => {
  const config = getConfig();
  if (config.apiKey === undefined) {
    throw new OntosError('ONTOS_STOREFRONT_API_KEY is not configured', 503, 'storefront_not_configured');
  }
  let revision = liveRevision ?? (await fetchActiveRevision(deadline)) ?? config.compositionRevision;
  if (revision === undefined) {
    throw new OntosError('No composition revision (publisher unreachable)', 503, 'composition_unavailable');
  }
  let response = await requestContext(audience, revision, deadline);
  if (response.status === 409 || response.status === 400) {
    const refreshed = await fetchActiveRevision(deadline);
    if (refreshed !== undefined && refreshed !== revision) {
      revision = refreshed;
      response = await requestContext(audience, refreshed, deadline);
    }
  }
  const text = await responseText(response);
  if (!response.ok) {
    const problem = parseProblem(text);
    throw new OntosError(
      `Gateway assertion for ${audience} failed: HTTP ${response.status} ${problem.code ?? ''}`.trim(),
      response.status,
      problem.code ?? 'gateway_context_failed',
      problem.detail ?? problem.title,
    );
  }
  const body = JSON.parse(text) as Partial<GatewayContext>;
  if (typeof body.apiBaseUrl !== 'string' || typeof body.token !== 'string') {
    throw new OntosError('Gateway context response is malformed', 502, 'gateway_context_malformed');
  }
  return {
    apiBaseUrl: body.apiBaseUrl,
    compositionRevision: typeof body.compositionRevision === 'string' ? body.compositionRevision : revision,
    token: body.token,
  };
};

const segment = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) throw new Error(`Invalid path segment ${value}`);
  return encodeURIComponent(value);
};

const post = async (
  context: GatewayContext,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  deadline?: AbortSignal,
): Promise<unknown> => {
  const { shellUrl } = getConfig();
  const correlationId = randomUUID();
  const response = await reach(`${shellUrl}${context.apiBaseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${context.token}`,
      'content-type': 'application/json',
      'x-correlation-id': correlationId,
      'x-ontos-composition-revision': context.compositionRevision,
      ...headers,
    },
    method: 'POST',
    signal: requestSignal(20_000, deadline),
  });
  const text = await responseText(response);
  if (!response.ok) {
    const problem = parseProblem(text);
    console.error(`[ontos] ${path} -> HTTP ${response.status} ${problem.code ?? ''} (correlation ${correlationId})`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    throw new OntosError(
      `OntOS ${path} failed: HTTP ${response.status} ${problem.code ?? ''}`.trim(),
      response.status,
      problem.code,
      problem.detail ?? problem.title,
      parsed,
    );
  }
  return JSON.parse(text) as unknown;
};

// Cover short local rebuilds, not an indefinite outage. One deadline bounds discovery, assertions,
// reads and backoff together; no stale snapshot can turn an unsuccessful validation into success.
const READ_BACKOFF_MS = [400, 800, 1200, 2000, 3000, 4000, 4000] as const;
const READ_DEADLINE_MS = 20_000;

/** Governed records read: ask the gateway for an admitted context on every attempt. */
export const readRecords = async (vertical: string, readName: string, query: unknown): Promise<unknown> => {
  const deadline = AbortSignal.timeout(READ_DEADLINE_MS);
  for (let attempt = 0; ; attempt += 1) {
    let reading = false;
    try {
      const context = await gatewayContext(vertical, deadline);
      reading = true;
      return await post(context, `/reads/${segment(readName)}`, query, {}, deadline);
    } catch (error) {
      if (!(error instanceof OntosError)) throw error;
      // Release mismatch is also a read-side 401 while issuer/verifier composition views converge.
      // Reacquire context within this SAME budget; never retry gateway credential rejection,
      // permission denial, business validation, or an Action. Every attempt still passes Core.
      const retryable = [502, 503, 504, 409].includes(error.status) || (reading && error.status === 401);
      const wait = READ_BACKOFF_MS[attempt];
      if (!retryable || error.code === 'storefront_not_configured' || wait === undefined || deadline.aborted) throw error;
      // Rediscover composition after *any* transient failure, not just a visible 409.
      liveRevision = undefined;
      await delay(wait, undefined, { signal: deadline }).catch(() => { throw error; });
    }
  }
};

/** Governed action. `idempotencyKey` must be reused verbatim (with the identical payload) on retries. */
export const callAction = async (
  vertical: string,
  actionSlug: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<unknown> => {
  const context = await gatewayContext(vertical);
  return await post(context, `/${segment(vertical)}/actions/${segment(actionSlug)}`, payload, {
    'idempotency-key': idempotencyKey,
  });
};
