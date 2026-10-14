import { existsSync, readFileSync } from 'node:fs';

export interface AgentConfig {
  readonly apiKey: string;
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

  const apiKey = read('ONTOS_AGENT_API_KEY');
  if (apiKey === undefined) {
    throw new Error(
      'ONTOS_AGENT_API_KEY is required. Set it in the environment or in app/.env.demo.local (gitignored).',
    );
  }

  return {
    apiKey,
    compositionRevision: read('ONTOS_COMPOSITION_REVISION'),
    compositionUrl: read('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL') ?? DEFAULT_COMPOSITION_URL,
    legalEntityId: read('ONTOS_LEGAL_ENTITY_ID'),
    shellUrl: (read('ONTOS_SHELL_URL') ?? DEFAULT_SHELL_URL).replace(/\/+$/u, ''),
  };
};

let cachedConfig: AgentConfig | undefined;

/** Loads configuration once per process. Throws when ONTOS_AGENT_API_KEY is missing. */
export const getConfig = (): AgentConfig => {
  cachedConfig ??= loadConfig();
  return cachedConfig;
};
