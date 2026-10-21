import { AsyncLocalStorage } from 'node:async_hooks';
import { getConfig } from './config.ts';

/** read_only: no writes. approval: writes become proposals a person approves. direct: governed Actions run. */
export type WritePolicy = 'read_only' | 'approval' | 'direct';

/** stdio internal runners only: a Better Auth API key from the environment (ONTOS_AGENT_*). Never accepted over HTTP. */
export interface ApiKeySession {
  readonly kind: 'api_key';
  readonly apiKey: string;
  legalEntityId: string | undefined;
  /** Short human label for logs and whoami, never the key, e.g. "profil B (Obchodní firma)" or "API klíč abc…". */
  readonly label: string;
  readonly transport: 'stdio' | 'http';
  readonly writePolicyOverride: WritePolicy | undefined;
}

/** HTTP: one OAuth connection grant. The user JWT is sent only to the shell connector endpoints, never to verticals. */
export interface OAuthConnectionSession {
  readonly kind: 'oauth_connection';
  readonly accessToken: string;
  readonly connectorSecret: string;
  readonly grantId: string;
  readonly legalEntityId: string;
  readonly label: string;
  readonly transport: 'http';
  readonly writePolicyOverride: undefined;
}

export type PrincipalSession = ApiKeySession | OAuthConnectionSession;

const storage = new AsyncLocalStorage<PrincipalSession>();
let defaultSession: PrincipalSession | undefined;

/** stdio: the process-wide session used when no `runWithPrincipal` scope is active. */
export const setDefaultPrincipal = (session: PrincipalSession): void => {
  defaultSession = session;
};

/** Runs `body` with every gateway call inside it authenticated as `session`. */
export const runWithPrincipal = <A>(session: PrincipalSession, body: () => Promise<A>): Promise<A> =>
  storage.run(session, body);

/** Same principal, another company, for one call (does not change the session). An OAuth connection is fixed to one company. */
export const withCompany = (session: PrincipalSession, legalEntityId: string | undefined): PrincipalSession =>
  session.kind === 'oauth_connection' ? session : { ...session, legalEntityId };

/** Session from the environment (legacy stdio behaviour: ONTOS_AGENT_API_KEY or the A/B/C profile key). */
export const sessionFromConfig = (): ApiKeySession => {
  const config = getConfig();
  return {
    apiKey: config.apiKey,
    kind: 'api_key',
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
