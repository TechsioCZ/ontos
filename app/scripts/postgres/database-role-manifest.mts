/// <reference types="node" />

import {
  BEARER_ASSERTION_ROLE_SETTINGS,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  PARTY_REGISTRY_WORKER_IDENTITY,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  TRUST_ROUTINES,
} from '../../packages/core-runtime/src/db/database-identities.ts';
import type {
  DatabaseAcceptedFinding,
  DatabaseIdentity,
  DatabaseRoleGrants,
} from '../../packages/core-runtime/src/db/database-identities.ts';
import {
  PARTY_REGISTRY_REQUEST_DATABASE_GRANTS,
  PARTY_REGISTRY_WORKER_DATABASE_GRANTS,
} from '../../verticals/party-registry/src/db/database-grants.ts';

export { TRUST_ROUTINES } from '../../packages/core-runtime/src/db/database-identities.ts';

const routinesExecutableBy = (role: string): readonly string[] =>
  TRUST_ROUTINES.flatMap(({ executableBy, signature }) => (executableBy.includes(role) ? [signature] : []));

export type DatabaseRoleGrantManifestEntry =
  | {
      readonly acceptedFindings: readonly DatabaseAcceptedFinding[];
      readonly databaseTemporary: true;
      readonly identity: DatabaseIdentity;
      readonly kind: 'legacy_shared';
      readonly revokedSchemas: readonly string[];
      readonly roleSettings: readonly string[];
    }
  | {
      readonly databaseTemporary: false;
      readonly grants: DatabaseRoleGrants;
      readonly identity: DatabaseIdentity;
      readonly kind: 'explicit';
      readonly roleSettings: readonly string[];
    };

const SHARED_RUNTIME_BASELINE_REASON = 'pre-pilot shared-runtime baseline for non-pilot verticals';

export const DATABASE_ROLE_GRANT_MANIFEST: readonly DatabaseRoleGrantManifestEntry[] = [
  {
    acceptedFindings: [
      'runtime_role_has_cross_schema_dml',
      'runtime_role_can_forge_trusted_context',
      'runtime_role_can_execute_security_definer',
      'runtime_role_has_temporary_authority',
    ].map((code) => ({ code, objects: 'all', reason: SHARED_RUNTIME_BASELINE_REASON })),
    databaseTemporary: true,
    identity: SHARED_RUNTIME_IDENTITY,
    kind: 'legacy_shared',
    revokedSchemas: ['party', 'contacts'],
    roleSettings: [],
  },
  {
    databaseTemporary: false,
    grants: {
      acceptedFindings: [],
      routines: routinesExecutableBy(SHELL_GATEWAY_ISSUER_IDENTITY.role),
      schemas: ['trust'],
      sequences: [],
      tables: [],
    },
    identity: SHELL_GATEWAY_ISSUER_IDENTITY,
    kind: 'explicit',
    roleSettings: BEARER_ASSERTION_ROLE_SETTINGS,
  },
  {
    databaseTemporary: false,
    grants: PARTY_REGISTRY_REQUEST_DATABASE_GRANTS,
    identity: PARTY_REGISTRY_REQUEST_IDENTITY,
    kind: 'explicit',
    roleSettings: BEARER_ASSERTION_ROLE_SETTINGS,
  },
  {
    databaseTemporary: false,
    grants: PARTY_REGISTRY_WORKER_DATABASE_GRANTS,
    identity: PARTY_REGISTRY_WORKER_IDENTITY,
    kind: 'explicit',
    roleSettings: [],
  },
];

export const manifestEntryForRole = (role: string): DatabaseRoleGrantManifestEntry | undefined =>
  DATABASE_ROLE_GRANT_MANIFEST.find((entry) => entry.identity.role === role);
