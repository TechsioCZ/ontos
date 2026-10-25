/// <reference types="node" />
import { PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR } from '@app/party-registry/database-identities';
import { Result, Schema } from 'effect';
import { APP_DATABASE_IDENTITY_ENROLLMENT, TRUST_ROUTINES } from '../../database/identity-enrollment.ts';
import type { DatabaseIdentityEnrollment } from '@app/core-runtime/db/database-identity-manifest';

import {
  BEARER_ASSERTION_ROLE_SETTINGS,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
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

export { TRUST_ROUTINES } from '../../database/identity-enrollment.ts';

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

export class DatabaseRoleGrantManifestConfigurationError extends Schema.TaggedError<DatabaseRoleGrantManifestConfigurationError>()(
  'DatabaseRoleGrantManifestConfigurationError',
  { reason: Schema.String },
) {}

const invalidGrantManifest = (reason: string) =>
  Result.fail(new DatabaseRoleGrantManifestConfigurationError({ reason }));

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameIdentity = (left: DatabaseIdentity, right: DatabaseIdentity): boolean =>
  left.id === right.id &&
  left.role === right.role &&
  left.ownerModuleKey === right.ownerModuleKey &&
  left.urlKey === right.urlKey &&
  left.scopeAuthority === right.scopeAuthority &&
  left.handlesBearerAssertions === right.handlesBearerAssertions &&
  left.registersGatewayScopeGrants === right.registersGatewayScopeGrants &&
  sameStrings(left.gatewayScopeAudiences, right.gatewayScopeAudiences) &&
  left.cloudflareHyperdrive?.binding === right.cloudflareHyperdrive?.binding &&
  left.cloudflareHyperdrive?.idVariable === right.cloudflareHyperdrive?.idVariable;

const validateExplicitGrants = (
  enrollment: DatabaseIdentityEnrollment,
  entry: Extract<DatabaseRoleGrantManifestEntry, { readonly kind: 'explicit' }>,
): Result.Result<void, DatabaseRoleGrantManifestConfigurationError> =>
  Result.gen(function* validateGrantSchemas() {
    const { grants, identity } = entry;
    const owner = enrollment.owners.find(({ moduleKey }) => moduleKey === identity.ownerModuleKey);
    if (identity.ownerModuleKey !== null && owner === undefined) {
      return yield* invalidGrantManifest(`Grant identity ${identity.id} has no enrolled schema owner`);
    }
    const allowedSchemas = owner === undefined ? ['trust'] : [...owner.schemas, 'core', 'trust', 'public'];
    if (
      new Set(grants.schemas).size !== grants.schemas.length ||
      grants.schemas.some((schema) => !allowedSchemas.includes(schema))
    ) {
      return yield* invalidGrantManifest(
        `Grant identity ${identity.id} has schemas outside its enrolled owner mapping`,
      );
    }
    for (const name of [
      ...grants.tables.map(({ table }) => table),
      ...grants.sequences.map(({ sequence }) => sequence),
      ...grants.routines,
    ]) {
      const separator = name.indexOf('.');
      if (separator <= 0 || !grants.schemas.includes(name.slice(0, separator))) {
        return yield* invalidGrantManifest(`Grant object ${name} for ${identity.id} has no declared schema grant`);
      }
    }
    for (const signature of grants.routines.filter((routine) => routine.startsWith('trust.'))) {
      const routine = enrollment.trustRoutines.find((candidate) => candidate.signature === signature);
      if (routine === undefined || !routine.executableBy.includes(identity.role)) {
        return yield* invalidGrantManifest(`Grant identity ${identity.id} is not an enrolled executor of ${signature}`);
      }
    }
    for (const routine of enrollment.trustRoutines) {
      if (routine.executableBy.includes(identity.role) && !grants.routines.includes(routine.signature)) {
        return yield* invalidGrantManifest(
          `Grant identity ${identity.id} is missing its enrolled routine ${routine.signature}`,
        );
      }
    }
    return yield* Result.void;
  });

/** Bind explicit application grants to the complete enrollment before any administrative work begins. */
export const defineDatabaseRoleGrantManifest = (
  enrollment: DatabaseIdentityEnrollment,
  entries: readonly DatabaseRoleGrantManifestEntry[],
): readonly DatabaseRoleGrantManifestEntry[] =>
  Result.gen(function* validateApplicationGrantManifest() {
    const seenIdentities = new Set<string>();
    const manifest: DatabaseRoleGrantManifestEntry[] = [];
    for (const entry of entries) {
      const identity = enrollment.identities.find(({ id }) => id === entry.identity.id);
      if (identity === undefined || !sameIdentity(identity, entry.identity)) {
        return yield* invalidGrantManifest(
          `Grant identity ${entry.identity.id} does not match the application enrollment`,
        );
      }
      if (seenIdentities.has(identity.id)) {
        return yield* invalidGrantManifest(`Grant identity ${identity.id} has more than one grant descriptor`);
      }
      seenIdentities.add(identity.id);
      if (
        !sameStrings(entry.roleSettings, identity.handlesBearerAssertions ? BEARER_ASSERTION_ROLE_SETTINGS : []) ||
        (entry.kind === 'legacy_shared') !== (identity.id === SHARED_RUNTIME_IDENTITY.id)
      ) {
        return yield* invalidGrantManifest(`Grant identity ${identity.id} has inconsistent role authority settings`);
      }
      if (entry.kind === 'explicit') {
        yield* validateExplicitGrants(enrollment, entry);
      } else if (
        !sameStrings(
          entry.revokedSchemas,
          enrollment.owners.flatMap(({ schemas }) => schemas),
        )
      ) {
        return yield* invalidGrantManifest(
          'Shared runtime schema revocations do not cover the complete application enrollment',
        );
      }
      manifest.push(Object.freeze({ ...entry, identity }));
    }
    for (const identity of enrollment.identities) {
      if (!seenIdentities.has(identity.id)) {
        return yield* invalidGrantManifest(
          `Enrolled identity ${identity.id} (${identity.role}) has no grant descriptor`,
        );
      }
    }
    return Object.freeze(manifest);
  }).pipe(Result.getOrThrow);

export const DATABASE_ROLE_GRANT_MANIFEST = defineDatabaseRoleGrantManifest(APP_DATABASE_IDENTITY_ENROLLMENT, [
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
    revokedSchemas: APP_DATABASE_IDENTITY_ENROLLMENT.owners.flatMap(({ schemas }) => schemas),
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
    identity: PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR.request,
    kind: 'explicit',
    roleSettings: BEARER_ASSERTION_ROLE_SETTINGS,
  },
  {
    databaseTemporary: false,
    grants: PARTY_REGISTRY_WORKER_DATABASE_GRANTS,
    identity: PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR.worker,
    kind: 'explicit',
    roleSettings: [],
  },
]);

export const manifestEntryForRole = (role: string): DatabaseRoleGrantManifestEntry | undefined =>
  DATABASE_ROLE_GRANT_MANIFEST.find((entry) => entry.identity.role === role);
