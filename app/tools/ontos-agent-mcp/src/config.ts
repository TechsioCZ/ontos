import { existsSync, readFileSync } from 'node:fs';

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

let cachedConfig: AgentConfig | undefined;

/** Loads configuration once per process. Throws when ONTOS_AGENT_API_KEY is missing. */
export const getConfig = (): AgentConfig => {
  cachedConfig ??= loadConfig();
  return cachedConfig;
};
