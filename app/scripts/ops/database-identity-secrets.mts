import {
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '../../packages/core-runtime/src/db/database-identities.ts';
import type { DatabaseIdentity } from '../../packages/core-runtime/src/db/database-identities.ts';

/**
 * The dedicated PostgreSQL logins of the pilot identities (design D11). Their passwords are sensitive
 * service secrets on the Zerops `migrator` service, never project variables: every service inherits
 * project variables, so each service that needs a password references `${migrator_<KEY>}` itself.
 * This module has no runtime dependencies, so deployment generators can import it.
 */
export const MIGRATOR_SERVICE_HOSTNAME = 'migrator';

export interface DatabaseIdentitySecret {
  readonly identity: DatabaseIdentity;
  /** The secret key on the `migrator` service. */
  readonly secretKey: string;
}

export const PARTY_REGISTRY_REQUEST_SECRET: DatabaseIdentitySecret = {
  identity: PARTY_REGISTRY_REQUEST_IDENTITY,
  secretKey: 'PARTY_REGISTRY_DB_PASSWORD',
};
export const PARTY_REGISTRY_WORKER_SECRET: DatabaseIdentitySecret = {
  identity: PARTY_REGISTRY_WORKER_IDENTITY,
  secretKey: 'PARTY_REGISTRY_WORKER_DB_PASSWORD',
};
export const SHELL_GATEWAY_ISSUER_SECRET: DatabaseIdentitySecret = {
  identity: SHELL_GATEWAY_ISSUER_IDENTITY,
  secretKey: 'SHELL_GATEWAY_ISSUER_DB_PASSWORD',
};

export const DATABASE_IDENTITY_SECRETS: readonly DatabaseIdentitySecret[] = [
  PARTY_REGISTRY_REQUEST_SECRET,
  PARTY_REGISTRY_WORKER_SECRET,
  SHELL_GATEWAY_ISSUER_SECRET,
];

/** The `migrator_<KEY>` name that `${migrator_<KEY>}` references and `readZeropsValue` reads. */
export const migratorSecretReference = (secretKey: string) => `${MIGRATOR_SERVICE_HOSTNAME}_${secretKey}`;

const zeropsDatabaseUrl = (role: string, passwordReference: string) =>
  `postgresql://${role}:\${${passwordReference}}@\${db18_hostname}:\${db18_port}/\${db18_dbName}`;

/**
 * The Zerops `envVariables` value of a dedicated identity's database URL. Other services reference the
 * `migrator` secret as `${migrator_<KEY>}`; the migrator references its own secret as `${<KEY>}`,
 * because Zerops resolves a service's own variables without the hostname prefix.
 */
export const zeropsIdentityDatabaseUrl = ({ identity, secretKey }: DatabaseIdentitySecret, service: string): string =>
  zeropsDatabaseUrl(
    identity.role,
    service === MIGRATOR_SERVICE_HOSTNAME ? secretKey : migratorSecretReference(secretKey),
  );
