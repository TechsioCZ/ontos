/**
 * Principal capabilities (lane mcp-gateway): which companies and modules an API key may read or write.
 *
 * Two sources, tried in order:
 *   1. endpoint: the shell capability endpoint (CAPABILITY_ENDPOINT_PATH). Used when it answers 200 with the contract.
 *   2. probe: gateway-context per demo company (403 = not a member) plus one read per module. A module read answers
 *      403 when the principal may not read the module; a records read with `canWrite` / `viewer` / `access` hints
 *      the write side (see detectWrite).
 * Results are cached per key and composition revision for CAPABILITY_TTL_MS. Never log the key or tokens.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Schema } from 'effect';
import { z } from 'zod';
import { DEMO_COMPANIES, getEndpoints } from '../config.ts';
import { getGatewayContext } from '../gateway.ts';
import type { GatewayContext } from '../gateway.ts';
import { OntosRequestError, readRecords } from '../ontos-client.ts';
import { runWithPrincipal, withCompany } from '../session.ts';
import type { PrincipalSession } from '../session.ts';
import { describeError } from '../tools/shared.ts';
import type {
  Access,
  Catalog,
  CatalogModule,
  CompanyCapabilities,
  ModuleCapability,
  PrincipalCapabilities,
} from './types.ts';

export const CAPABILITY_ENDPOINT_PATH = '/shell-super-app-api/auth/api-key/capabilities';
export const CAPABILITY_TTL_MS = 120_000;

/** Parallel module probes per company. */
const PROBE_CONCURRENCY = 6;

const CapabilityEndpointSchema = z.object({
  principal: z.object({
    principalId: z.string(),
    displayName: z.string(),
    kind: z.enum(['human', 'agent']),
  }),
  writePolicy: z.enum(['direct', 'approval']),
  companies: z.array(
    z.object({
      legalEntityId: z.string(),
      legalName: z.string(),
      modules: z.array(z.object({ moduleId: z.string(), read: z.boolean(), write: z.boolean() })),
    }),
  ),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Write side of a records body: an explicit `canWrite`, the CRM viewer grants, or the operations agenda flags. */
export const detectWrite = (moduleId: string, body: unknown): { readonly write: Access; readonly note: string } => {
  if (isRecord(body) && typeof body['canWrite'] === 'boolean') {
    const canWrite = body['canWrite'];
    return { note: `zápis: canWrite=${canWrite}`, write: canWrite ? 'allowed' : 'denied' };
  }
  if (moduleId === 'demo.crm' && isRecord(body) && isRecord(body['viewer'])) {
    const viewer = body['viewer'];
    const allowed = viewer['writeAll'] === true || viewer['writeAssigned'] === true;
    return { note: 'zápis: CRM viewer', write: allowed ? 'allowed' : 'denied' };
  }
  if (moduleId === 'demo.siampark-ops' && isRecord(body) && Array.isArray(body['access'])) {
    const access: readonly unknown[] = body['access'];
    const allowed = access.some((entry) => isRecord(entry) && entry['canWrite'] === true);
    return { note: 'zápis: agendy provozu', write: allowed ? 'allowed' : 'denied' };
  }
  return { note: 'zápis nelze předem ověřit; rozhodne server', write: 'unknown' };
};

/** Reads `principal.principalId` (or `sub`) from an assertion JWT payload. Signature is not checked here. */
export const principalIdFromToken = (token: string): string | undefined => {
  const part = token.split('.')[1];
  if (part === undefined) {
    return undefined;
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf-8'));
    if (!isRecord(payload)) {
      return undefined;
    }
    const principal = payload['principal'];
    if (isRecord(principal) && typeof principal['principalId'] === 'string') {
      return principal['principalId'];
    }
    return typeof payload['sub'] === 'string' ? payload['sub'] : undefined;
  } catch {
    return undefined;
  }
};

interface CacheEntry {
  readonly at: number;
  readonly value: PrincipalCapabilities;
}

const cache = new Map<string, CacheEntry>();

export const clearCapabilityCache = (): void => {
  cache.clear();
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs `fn` over `items` with at most `limit` calls in flight; results keep the input order. */
const mapLimit = async <T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array<R>(items.length);
  const entries = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of entries) {
      results[index] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
};

const fromEndpoint = async (
  session: PrincipalSession,
  catalog: Catalog,
): Promise<PrincipalCapabilities | undefined> => {
  let response: Response;
  try {
    response = await fetch(`${getEndpoints().shellUrl}${CAPABILITY_ENDPOINT_PATH}`, {
      body: '{}',
      headers: {
        'content-type': 'application/json',
        'x-api-key': session.apiKey,
        'x-correlation-id': randomUUID(),
      },
      method: 'POST',
    });
  } catch {
    return undefined;
  }
  if (response.status !== 200) {
    return undefined;
  }
  const parsed = CapabilityEndpointSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    process.stderr.write('capability endpoint answered an unknown shape; probing instead\n');
    return undefined;
  }
  const answer = parsed.data;
  return {
    displayName: answer.principal.displayName,
    kind: answer.principal.kind,
    principalId: answer.principal.principalId,
    resolvedAt: new Date().toISOString(),
    source: 'endpoint',
    writePolicy: session.writePolicyOverride === 'approval' || answer.writePolicy === 'approval' ? 'approval' : 'direct',
    companies: answer.companies.map(
      (company): CompanyCapabilities => ({
        label: company.legalName,
        legalEntityId: company.legalEntityId,
        modules: catalog.modules.map((module): ModuleCapability => {
          const found = company.modules.find((entry) => entry.moduleId === module.moduleId);
          return {
            moduleId: module.moduleId,
            note: 'podle oprávnění v shellu',
            read: found?.read === true ? 'allowed' : 'denied',
            write: found?.write === true ? 'allowed' : 'denied',
          };
        }),
      }),
    ),
  };
};

/** One module's access in one company: a records read is the probe; 403/404 mean denied. */
const probeModule = async (
  session: PrincipalSession,
  legalEntityId: string,
  module: CatalogModule,
): Promise<ModuleCapability> => {
  const slug = module.probeReadSlug;
  if (slug === undefined) {
    return { moduleId: module.moduleId, note: 'nelze ověřit předem', read: 'unknown', write: 'unknown' };
  }
  try {
    const body = await runWithPrincipal(withCompany(session, legalEntityId), () =>
      readRecords(module.appId, slug, {}, Schema.Json),
    );
    const { note, write } = detectWrite(module.moduleId, body);
    return { moduleId: module.moduleId, note: `čtení ověřeno; ${note}`, read: 'allowed', write };
  } catch (error) {
    if (Schema.is(OntosRequestError)(error) && (error.status === 403 || error.status === 404)) {
      const code = error.code === undefined ? '' : ` ${error.code}`;
      return { moduleId: module.moduleId, note: `HTTP ${error.status}${code}`, read: 'denied', write: 'denied' };
    }
    return {
      moduleId: module.moduleId,
      note: describeError(error).slice(0, 160),
      read: 'unknown',
      write: 'unknown',
    };
  }
};

const fromProbe = async (session: PrincipalSession, catalog: Catalog): Promise<PrincipalCapabilities> => {
  const audience = catalog.modules.find((module) => module.probeReadSlug !== undefined)?.appId ?? 'workforce';

  // Membership: a gateway assertion for the company succeeds only when the key's principal belongs to it.
  const members: { readonly legalEntityId: string; readonly label: string }[] = [];
  let principalId: string | undefined;
  for (const company of DEMO_COMPANIES) {
    let context: GatewayContext;
    try {
      context = await runWithPrincipal(withCompany(session, company.legalEntityId), () =>
        getGatewayContext(audience),
      );
    } catch (error) {
      const message = errorMessage(error);
      if (/HTTP 403/u.test(message)) {
        continue;
      }
      if (/HTTP 401/u.test(message)) {
        throw new Error('Token byl odmítnut (HTTP 401): neplatný nebo zneplatněný API klíč.');
      }
      throw error;
    }
    principalId ??= principalIdFromToken(context.token);
    members.push({ label: company.label, legalEntityId: company.legalEntityId });
  }

  const companies: CompanyCapabilities[] = [];
  for (const member of members) {
    const modules = await mapLimit(catalog.modules, PROBE_CONCURRENCY, (module) =>
      probeModule(session, member.legalEntityId, module),
    );
    companies.push({ label: member.label, legalEntityId: member.legalEntityId, modules });
  }

  return {
    companies,
    displayName: undefined,
    kind: 'unknown',
    principalId,
    resolvedAt: new Date().toISOString(),
    source: 'probe',
    writePolicy: session.writePolicyOverride ?? 'direct',
  };
};

/** What the principal may do per company and module. Cached for CAPABILITY_TTL_MS unless `refresh` is set. */
export const resolveCapabilities = async (
  session: PrincipalSession,
  catalog: Catalog,
  options: { readonly refresh?: boolean } = {},
): Promise<PrincipalCapabilities> => {
  const key = `${createHash('sha256').update(session.apiKey).digest('hex')}:${catalog.compositionRevision}`;
  const cached = cache.get(key);
  if (options.refresh !== true && cached !== undefined && Date.now() - cached.at < CAPABILITY_TTL_MS) {
    return cached.value;
  }
  const value = (await fromEndpoint(session, catalog)) ?? (await fromProbe(session, catalog));
  cache.set(key, { at: Date.now(), value });
  return value;
};
