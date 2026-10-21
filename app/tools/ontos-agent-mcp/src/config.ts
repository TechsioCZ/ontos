import { existsSync, readFileSync } from 'node:fs';
import type { RsConfig } from './oauth/types.ts';

/**
 * AI agent levels (specs AGENT.md). A: read-only. B: reads + tasks. C: proposals approved by a person in the app
 * (Hanák: CRM clients and order pairing; Obchodní firma: opportunities and orders). Unset: the legacy `agent-bot`.
 */
export type AgentProfile = 'A' | 'B' | 'C';

/** Demo companies with AI principals (scripts/demo/ai-profiles.mts). */
export const AGENT_COMPANIES = {
  hanak: { envKey: 'HANAK', label: 'Velkoobchod Hanák s.r.o.', legalEntityId: '71000000-0000-4000-8000-000000000022' },
  obchod: { envKey: 'OBCHOD', label: 'Obchodní firma', legalEntityId: '71000000-0000-4000-8000-000000000020' },
} as const;
export type AgentCompany = keyof typeof AGENT_COMPANIES;

export interface AgentConfig {
  readonly apiKey: string;
  /** Company the profile key belongs to; undefined without a profile. */
  readonly company: AgentCompany | undefined;
  /** Name of the variable the API key came from (never the key itself). */
  readonly apiKeySource: string;
  readonly profile: AgentProfile | undefined;
  /** Live release revision (64 lowercase hex). The shell rejects gateway requests that do not match its catalog. */
  readonly compositionRevision: string | undefined;
  /** Composition publisher endpoint; its `composition.revision` replaces a missing or stale revision. */
  readonly compositionUrl: string;
  readonly legalEntityId: string | undefined;
  readonly shellUrl: string;
}

/** app/.env.demo.local, resolved from this file: src -> ontos-agent-mcp -> tools -> app. */
const DEMO_ENV_FILE = new URL('../../../.env.demo.local', import.meta.url);

export const DEFAULT_SHELL_URL = 'http://localhost:3020';
export const DEFAULT_COMPOSITION_URL = 'http://127.0.0.1:3041/active';

/** Strips one pair of matching single or double quotes around a value. */
const unquote = (value: string): string => {
  const quote = value.at(0);
  return value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote) ? value.slice(1, -1) : value;
};

/** One `KEY=VALUE` line, or undefined for blanks, comments and lines without a key. */
const parseEnvLine = (rawLine: string): readonly [string, string] | undefined => {
  const line = rawLine.trim();
  if (line === '' || line.startsWith('#')) {
    return undefined;
  }
  const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
  const separator = body.indexOf('=');
  if (separator <= 0) {
    return undefined;
  }
  return [body.slice(0, separator).trim(), unquote(body.slice(separator + 1).trim())];
};

/** Minimal KEY=VALUE parser: comments, blank lines, optional `export `, optional single/double quotes. */
export const parseEnvFile = (text: string) =>
  Object.fromEntries(
    text
      .split(/\r?\n/u)
      .map(parseEnvLine)
      .filter((entry): entry is readonly [string, string] => entry !== undefined),
  );

const readDemoEnvFile = () => parseEnvFile(existsSync(DEMO_ENV_FILE) ? readFileSync(DEMO_ENV_FILE, 'utf-8') : '');

/** Process environment wins; app/.env.demo.local fills in what the environment does not set. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AgentConfig => {
  const fileValues = readDemoEnvFile();
  const read = (key: string): string | undefined => (env[key] ?? fileValues[key])?.trim() || undefined;

  const rawProfile = read('ONTOS_AGENT_PROFILE')?.toUpperCase();
  if (rawProfile !== undefined && rawProfile !== 'A' && rawProfile !== 'B' && rawProfile !== 'C') {
    throw new Error(`ONTOS_AGENT_PROFILE must be A, B or C (got ${JSON.stringify(rawProfile)}).`);
  }
  const profile: AgentProfile | undefined = rawProfile;
  const rawCompany = read('ONTOS_AGENT_COMPANY')?.toLowerCase() ?? (profile === 'C' ? 'hanak' : 'obchod');
  if (rawCompany !== 'obchod' && rawCompany !== 'hanak') {
    throw new Error(`ONTOS_AGENT_COMPANY must be obchod or hanak (got ${JSON.stringify(rawCompany)}).`);
  }
  const company: AgentCompany | undefined = profile === undefined ? undefined : rawCompany;

  // A profile uses its own principal's key and company; it never falls back to the broader legacy bot key.
  const apiKeySource =
    profile === undefined || company === undefined
      ? 'ONTOS_AGENT_API_KEY'
      : `ONTOS_AGENT_${profile}_${AGENT_COMPANIES[company].envKey}_API_KEY`;
  const apiKey = read(apiKeySource);
  if (apiKey === undefined) {
    throw new Error(
      `${apiKeySource} is required. Set it in the environment or in app/.env.demo.local (gitignored; written by scripts/demo/reset-permissions.mts and scripts/demo/ai-profiles.mts).`,
    );
  }
  // With a profile the company decides the legal entity; only an explicit process variable overrides it.
  const legalEntityId =
    company === undefined
      ? read('ONTOS_LEGAL_ENTITY_ID')
      : ((env['ONTOS_LEGAL_ENTITY_ID']?.trim() || undefined) ?? AGENT_COMPANIES[company].legalEntityId);

  return {
    apiKey,
    apiKeySource,
    company,
    compositionRevision: read('ONTOS_COMPOSITION_REVISION'),
    compositionUrl: read('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL') ?? DEFAULT_COMPOSITION_URL,
    legalEntityId,
    profile,
    shellUrl: (read('ONTOS_SHELL_URL') ?? DEFAULT_SHELL_URL).replace(/\/+$/u, ''),
  };
};

/** Every demo company a principal may belong to (core-runtime install/demo-company-profiles.ts; Kavárna is legacy). */
export const DEMO_COMPANIES = [
  { key: 'obchod', label: 'Obchodní firma', legalEntityId: '71000000-0000-4000-8000-000000000020' },
  { key: 'siampark', label: 'Siampark', legalEntityId: '71000000-0000-4000-8000-000000000021' },
  { key: 'hanak', label: 'Velkoobchod Hanák s.r.o.', legalEntityId: '71000000-0000-4000-8000-000000000022' },
  { key: 'akros', label: 'AKROS (demo)', legalEntityId: '71000000-0000-4000-8000-000000000024' },
] as const;
export type DemoCompany = (typeof DEMO_COMPANIES)[number];

/** Shell and composition endpoints. Never throws and needs no API key (the HTTP transport has none of its own). */
export interface EndpointsConfig {
  readonly compositionRevision: string | undefined;
  readonly compositionUrl: string;
  readonly shellUrl: string;
}

export const loadEndpoints = (env: NodeJS.ProcessEnv = process.env): EndpointsConfig => {
  const fileValues = readDemoEnvFile();
  const read = (key: string): string | undefined => (env[key] ?? fileValues[key])?.trim() || undefined;
  return {
    compositionRevision: read('ONTOS_COMPOSITION_REVISION'),
    compositionUrl: read('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL') ?? DEFAULT_COMPOSITION_URL,
    shellUrl: (read('ONTOS_SHELL_URL') ?? DEFAULT_SHELL_URL).replace(/\/+$/u, ''),
  };
};

let cachedEndpoints: EndpointsConfig | undefined;

export const getEndpoints = (): EndpointsConfig => {
  cachedEndpoints ??= loadEndpoints();
  return cachedEndpoints;
};

/** Raw value of one variable: process environment first, then app/.env.demo.local. */
export const readSetting = (key: string, env: NodeJS.ProcessEnv = process.env): string | undefined =>
  (env[key] ?? readDemoEnvFile()[key])?.trim() || undefined;

let cachedConfig: AgentConfig | undefined;

/** Loads configuration once per process. Throws when ONTOS_AGENT_API_KEY is missing. */
export const getConfig = (): AgentConfig => {
  cachedConfig ??= loadConfig();
  return cachedConfig;
};

export const DEFAULT_OAUTH_ISSUER = 'http://localhost:3020/shell-super-app-api/oauth';
export const DEFAULT_MCP_RESOURCE_URL = 'http://localhost:3090/mcp';
/** Browser-based MCP clients that may send an Origin header (MCP Inspector runs on :6274). */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  'https://chatgpt.com',
  'https://claude.ai',
  'https://claude.com',
  'https://vscode.dev',
  'http://localhost:6274',
  'http://127.0.0.1:6274',
];

const withoutTrailingSlash = (value: string): string => value.replace(/\/+$/u, '');

/** OAuth resource-server settings (design §8.1). Throws on a missing connector secret or a trailing slash. */
export const loadRsConfig = (env: NodeJS.ProcessEnv = process.env): RsConfig => {
  const read = (key: string): string | undefined => readSetting(key, env);
  const list = (key: string): string[] =>
    (read(key) ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  const issuer = read('ONTOS_OAUTH_ISSUER') ?? DEFAULT_OAUTH_ISSUER;
  const resourceUrl = read('ONTOS_MCP_RESOURCE_URL') ?? DEFAULT_MCP_RESOURCE_URL;
  if (issuer.endsWith('/')) {
    throw new Error('ONTOS_OAUTH_ISSUER must not end with a slash.');
  }
  if (resourceUrl.endsWith('/')) {
    throw new Error('ONTOS_MCP_RESOURCE_URL must not end with a slash.');
  }
  const connectorSecret = read('ONTOS_MCP_CONNECTOR_SECRET');
  if (connectorSecret === undefined) {
    throw new Error('ONTOS_MCP_CONNECTOR_SECRET is required (app/.env.demo.local; the shell reads the same value).');
  }
  const port = Number(read('ONTOS_MCP_HTTP_PORT') ?? '3090');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('ONTOS_MCP_HTTP_PORT must be a port number.');
  }
  const resource = new URL(resourceUrl);
  const shellPublicUrl = withoutTrailingSlash(read('ONTOS_SHELL_PUBLIC_URL') ?? new URL(issuer).origin);
  return {
    allowedHosts: [...new Set([resource.host, `localhost:${port}`, `127.0.0.1:${port}`, ...list('ONTOS_MCP_ALLOWED_HOSTS')])],
    allowedOrigins: [...new Set([shellPublicUrl, ...DEFAULT_ALLOWED_ORIGINS, ...list('ONTOS_MCP_ALLOWED_ORIGINS')])],
    connectGuideUrl: `${shellPublicUrl}/cs/profil`,
    connectorSecret,
    host: read('ONTOS_MCP_HTTP_HOST') ?? '127.0.0.1',
    issuer,
    jwksUrl: read('ONTOS_OAUTH_JWKS_URL') ?? `${issuer}/jwks`,
    port,
    prmUrl: `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname === '/' ? '' : resource.pathname}`,
    resourceUrl,
    shellInternalUrl: withoutTrailingSlash(read('ONTOS_SHELL_INTERNAL_URL') ?? read('ONTOS_SHELL_URL') ?? DEFAULT_SHELL_URL),
    shellPublicUrl,
  };
};
