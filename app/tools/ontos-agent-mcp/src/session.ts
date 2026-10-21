import { AsyncLocalStorage } from 'node:async_hooks';
import { getConfig } from './config.ts';

/** Write policy of a principal: run Actions directly, or only submit proposals that a person approves. */
export type WritePolicy = 'direct' | 'approval';

/**
 * Who an MCP session acts as. stdio: one session from the environment (ONTOS_AGENT_*). HTTP: one per MCP session,
 * built from the request's bearer token. The token is sent only as `x-api-key` to the shell; never log it.
 */
export interface PrincipalSession {
  /** Shell API key (agent managed key or a person's own key). */
  readonly apiKey: string;
  /** Company the calls are scoped to; `ontos_switch_company` replaces it. Undefined: the key's default. */
  legalEntityId: string | undefined;
  /** Short human label for logs and whoami, never the key, e.g. "profil B (Obchodní firma)" or "API klíč abc…". */
  readonly label: string;
  readonly transport: 'stdio' | 'http';
  /** Set by legacy profile C (and the C keys over HTTP); the capability endpoint may decide otherwise. */
  readonly writePolicyOverride: WritePolicy | undefined;
}

const storage = new AsyncLocalStorage<PrincipalSession>();
let defaultSession: PrincipalSession | undefined;

/** stdio: the process-wide session used when no `runWithPrincipal` scope is active. */
export const setDefaultPrincipal = (session: PrincipalSession): void => {
  defaultSession = session;
};

/** Runs `body` with every gateway call inside it authenticated as `session`. */
export const runWithPrincipal = <A>(session: PrincipalSession, body: () => Promise<A>): Promise<A> =>
  storage.run(session, body);

/** Same principal, another company, for one call (does not change the session). */
export const withCompany = (session: PrincipalSession, legalEntityId: string | undefined): PrincipalSession => ({
  ...session,
  legalEntityId,
});

/** Session from the environment (legacy stdio behaviour: ONTOS_AGENT_API_KEY or the A/B/C profile key). */
export const sessionFromConfig = (): PrincipalSession => {
  const config = getConfig();
  return {
    apiKey: config.apiKey,
    label:
      config.profile === undefined
        ? `API klíč z ${config.apiKeySource}`
        : `profil ${config.profile} (${config.company ?? 'bez firmy'})`,
    legalEntityId: config.legalEntityId,
    transport: 'stdio',
    writePolicyOverride: config.profile === 'C' ? 'approval' : undefined,
  };
};

/** The active principal: the `runWithPrincipal` scope, else the default session, else the environment. */
export const currentPrincipal = (): PrincipalSession => {
  const scoped = storage.getStore();
  if (scoped !== undefined) {
    return scoped;
  }
  defaultSession ??= sessionFromConfig();
  return defaultSession;
};
