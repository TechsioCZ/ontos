import { existsSync, readFileSync } from 'node:fs';

export interface AgentConfig {
  readonly shellUrl: string;
  readonly apiKey: string;
  readonly legalEntityId: string | undefined;
  /** Live release revision (64 lowercase hex). The shell rejects gateway requests that do not match its catalog. */
  readonly compositionRevision: string | undefined;
}

/** app/.env.demo.local, resolved from this file: src -> ontos-agent-mcp -> tools -> app. */
const DEMO_ENV_FILE = new URL('../../../.env.demo.local', import.meta.url);

export const DEFAULT_SHELL_URL = 'http://localhost:3020';

/** Minimal KEY=VALUE parser: comments, blank lines, optional `export `, optional single/double quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = body.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const key = body.slice(0, separator).trim();
    let value = body.slice(separator + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function readDemoEnvFile(): Record<string, string> {
  const path = DEMO_ENV_FILE;
  if (!existsSync(path)) {
    return {};
  }
  return parseEnvFile(readFileSync(path, 'utf8'));
}

/** Process environment wins; app/.env.demo.local fills in what the environment does not set. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
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
    legalEntityId: read('ONTOS_LEGAL_ENTITY_ID'),
    shellUrl: (read('ONTOS_SHELL_URL') ?? DEFAULT_SHELL_URL).replace(/\/+$/u, ''),
  };
}

let cachedConfig: AgentConfig | undefined;

/** Loads configuration once per process. Throws when ONTOS_AGENT_API_KEY is missing. */
export function getConfig(): AgentConfig {
  cachedConfig ??= loadConfig();
  return cachedConfig;
}
