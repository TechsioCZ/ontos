import { getOrNull as getOptionOrNull } from 'effect/Option';
import { getOrThrow as getResultOrThrow, mapError as mapResultError } from 'effect/Result';
import {
  Array as ArraySchema,
  Boolean as BooleanSchema,
  Literals,
  OptionFromNullOr,
  String as StringSchema,
  Struct,
  TaggedError,
  Unknown as UnknownSchema,
  brand,
  check,
  decodeUnknownResult,
  isPattern,
  optionalKey,
} from 'effect/Schema';

import { freezeIdentity, SHARED_RUNTIME_IDENTITY, SHELL_GATEWAY_ISSUER_IDENTITY } from './database-identity-data.ts';

export {
  BEARER_ASSERTION_ROLE_SETTINGS,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from './database-identity-data.ts';

/** Owner-neutral identity contracts and enrollment validation. */
const DATABASE_SCOPE_AUTHORITIES = ['gateway_grant', 'session_setting', 'none'] as const;
export type DatabaseScopeAuthority = (typeof DATABASE_SCOPE_AUTHORITIES)[number];
const DATABASE_TABLE_PRIVILEGES = ['select', 'insert', 'update', 'delete'] as const;
export type DatabaseTablePrivilege = (typeof DATABASE_TABLE_PRIVILEGES)[number];
export type DatabaseIdentityId = DatabaseIdentity['id'];
export type DatabaseUrlKey = DatabaseIdentity['urlKey'];

export interface CloudflareHyperdriveBinding {
  readonly binding: string;
  readonly idVariable: string;
}
export interface DatabaseIdentity {
  readonly cloudflareHyperdrive: CloudflareHyperdriveBinding | null;
  readonly gatewayScopeAudiences: readonly string[];
  readonly handlesBearerAssertions: boolean;
  readonly id: string;
  readonly ownerModuleKey: string | null;
  readonly registersGatewayScopeGrants: boolean;
  readonly role: string;
  readonly scopeAuthority: DatabaseScopeAuthority;
  readonly urlKey: string;
}
export interface DatabaseTableGrant {
  readonly columns?: Readonly<Partial<Record<'select' | 'insert' | 'update', readonly string[]>>>;
  readonly privileges: readonly DatabaseTablePrivilege[];
  readonly reason: string;
  readonly table: string;
}
export interface DatabaseSequenceGrant {
  readonly privileges: readonly ('usage' | 'select')[];
  readonly reason: string;
  readonly sequence: string;
}
export interface DatabaseAcceptedFinding {
  readonly code: string;
  readonly objects: readonly string[] | 'all';
  readonly reason: string;
}
export interface DatabaseRoleGrants {
  readonly acceptedFindings: readonly DatabaseAcceptedFinding[];
  readonly routines: readonly string[];
  readonly schemas: readonly string[];
  readonly sequences: readonly DatabaseSequenceGrant[];
  readonly tables: readonly DatabaseTableGrant[];
}

/** Complete owner-authored enrollment facts. No executable registration or foreign schema is imported. */
export interface DatabaseOwnerIdentityDescriptor {
  readonly moduleKey: string;
  readonly policyPrefix: string;
  readonly request: DatabaseIdentity;
  readonly schemas: readonly string[];
  readonly worker: DatabaseIdentity;
}
export interface TrustRoutine {
  readonly executableBy: readonly string[];
  readonly securityDefiner: boolean;
  readonly signature: string;
}

const enrollmentBrand: unique symbol = Symbol('@app/core-runtime/db/DatabaseIdentityEnrollment');
export interface DatabaseIdentityEnrollment {
  readonly dedicatedModuleKeys: readonly string[];
  readonly [enrollmentBrand]: true;
  readonly identities: readonly DatabaseIdentity[];
  readonly owners: readonly DatabaseOwnerIdentityDescriptor[];
  readonly trustRoutines: readonly TrustRoutine[];
}

export class DatabaseIdentityEnrollmentError extends TaggedError<DatabaseIdentityEnrollmentError>()(
  'DatabaseIdentityEnrollmentError',
  { cause: optionalKey(UnknownSchema), reason: StringSchema },
) {}

/** Routine vocabulary is Core-owned; executor membership comes only from the supplied enrollment. */
export const trustRoutinesForIdentities = (identities: readonly DatabaseIdentity[]): readonly TrustRoutine[] => {
  const registrars = identities.flatMap((identity) => (identity.registersGatewayScopeGrants ? [identity.role] : []));
  const requests = identities.flatMap((identity) =>
    identity.scopeAuthority === 'gateway_grant' ? [identity.role] : [],
  );
  return Object.freeze([
    ...[
      {
        executableBy: registrars,
        signature: 'trust.register_gateway_scope_grant(text,text,uuid,uuid,uuid,uuid,timestamptz)',
      },
      ...[
        'trust.establish_gateway_scope(text)',
        'trust.current_tenant_id()',
        'trust.current_legal_entity_id()',
        'trust.auth_binding_issuing_legal_entity(uuid,uuid)',
      ].map((signature) => ({ executableBy: requests, signature })),
    ].map(({ executableBy, signature }) =>
      Object.freeze({ executableBy: Object.freeze([...executableBy]), securityDefiner: true, signature }),
    ),
    ...['trust.verified_scope()', 'trust.scope_payload(xid8,timestamptz,uuid,uuid)', 'trust.scope_mac(text)'].map(
      (signature) => Object.freeze({ executableBy: Object.freeze([]), securityDefiner: false, signature }),
    ),
  ]);
};

const IdentifierSchema = StringSchema.pipe(check(isPattern(/^[a-z][a-z0-9_]{0,62}$/u)));
const VariableSchema = StringSchema.pipe(check(isPattern(/^[A-Z][A-Z0-9_]*$/u)));
const ModuleKeySchema = StringSchema.pipe(
  check(isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u)),
  brand('DatabaseOwnerModuleKey'),
);
const AudienceSchema = StringSchema.pipe(check(isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)));
const IdentitySchema = Struct({
  cloudflareHyperdrive: OptionFromNullOr(Struct({ binding: VariableSchema, idVariable: VariableSchema })),
  gatewayScopeAudiences: ArraySchema(AudienceSchema),
  handlesBearerAssertions: BooleanSchema,
  id: IdentifierSchema,
  ownerModuleKey: OptionFromNullOr(ModuleKeySchema),
  registersGatewayScopeGrants: BooleanSchema,
  role: IdentifierSchema,
  scopeAuthority: Literals(DATABASE_SCOPE_AUTHORITIES),
  urlKey: VariableSchema.pipe(brand('DatabaseUrlKey')),
});
const DescriptorSchema = Struct({
  moduleKey: ModuleKeySchema,
  policyPrefix: IdentifierSchema,
  request: IdentitySchema,
  schemas: ArraySchema(IdentifierSchema),
  worker: IdentitySchema,
});
const decodeDescriptors = decodeUnknownResult(ArraySchema(DescriptorSchema), { onExcessProperty: 'error' });
const freezeDecodedIdentity = (identity: typeof IdentitySchema.Type): DatabaseIdentity =>
  freezeIdentity({
    ...identity,
    cloudflareHyperdrive: getOptionOrNull(identity.cloudflareHyperdrive),
    ownerModuleKey: getOptionOrNull(identity.ownerModuleKey),
  });
const invalidEnrollment = (reason: string): never => {
  throw new DatabaseIdentityEnrollmentError({ reason });
};
const assertUnique = (values: readonly string[], label: string): void => {
  if (new Set(values).size !== values.length) {
    invalidEnrollment(`Database identity enrollment has duplicate ${label}`);
  }
};
const reservedRole = (role: string): boolean => role === 'public' || role === 'postgres' || role.startsWith('pg_');
const PLATFORM_SCHEMAS = new Set(['auth', 'core', 'drizzle', 'email', 'information_schema', 'public', 'trust']);

/** Each application explicitly validates and freezes its complete owner graph. There is no global registry. */
export const defineDatabaseIdentityEnrollment = (
  descriptors: readonly DatabaseOwnerIdentityDescriptor[],
): DatabaseIdentityEnrollment => {
  const decoded = getResultOrThrow(
    decodeDescriptors(descriptors).pipe(
      mapResultError(
        (cause) =>
          new DatabaseIdentityEnrollmentError({
            cause,
            reason: 'Database identity enrollment descriptors are invalid',
          }),
      ),
    ),
  );
  const owners = decoded.map((owner) => {
    const request = freezeDecodedIdentity(owner.request);
    const worker = freezeDecodedIdentity(owner.worker);
    if (
      request.ownerModuleKey !== owner.moduleKey ||
      worker.ownerModuleKey !== owner.moduleKey ||
      request.scopeAuthority !== 'gateway_grant' ||
      !request.handlesBearerAssertions ||
      request.registersGatewayScopeGrants ||
      request.gatewayScopeAudiences.length === 0 ||
      worker.scopeAuthority !== 'session_setting' ||
      worker.handlesBearerAssertions ||
      worker.registersGatewayScopeGrants ||
      worker.gatewayScopeAudiences.length !== 0 ||
      worker.cloudflareHyperdrive !== null ||
      reservedRole(request.role) ||
      reservedRole(worker.role) ||
      owner.schemas.length === 0 ||
      owner.schemas.some((schema) => PLATFORM_SCHEMAS.has(schema) || schema.startsWith('pg_'))
    ) {
      invalidEnrollment('An owner descriptor has inconsistent identity authority or schema ownership');
    }
    return Object.freeze({
      moduleKey: owner.moduleKey,
      policyPrefix: owner.policyPrefix,
      request,
      schemas: Object.freeze([...owner.schemas]),
      worker,
    });
  });
  const identities = Object.freeze([
    SHARED_RUNTIME_IDENTITY,
    SHELL_GATEWAY_ISSUER_IDENTITY,
    ...owners.flatMap(({ request, worker }) => [request, worker]),
  ]);
  assertUnique(
    owners.map(({ moduleKey }) => moduleKey),
    'module keys',
  );
  assertUnique(
    owners.map(({ policyPrefix }) => policyPrefix),
    'policy prefixes',
  );
  assertUnique(
    owners.flatMap(({ schemas }) => schemas),
    'schema owners',
  );
  assertUnique(
    identities.map(({ id }) => id),
    'identity ids',
  );
  assertUnique(
    identities.map(({ role }) => role),
    'roles',
  );
  assertUnique(
    identities.map(({ urlKey }) => urlKey),
    'URL keys',
  );
  assertUnique(
    identities.flatMap(({ gatewayScopeAudiences }) => gatewayScopeAudiences),
    'gateway audiences',
  );
  assertUnique(
    identities.flatMap(({ cloudflareHyperdrive }) =>
      cloudflareHyperdrive === null ? [] : [cloudflareHyperdrive.binding],
    ),
    'Hyperdrive bindings',
  );
  assertUnique(
    identities.flatMap(({ cloudflareHyperdrive }) =>
      cloudflareHyperdrive === null ? [] : [cloudflareHyperdrive.idVariable],
    ),
    'Hyperdrive variables',
  );
  return Object.freeze({
    dedicatedModuleKeys: Object.freeze(owners.map(({ moduleKey }) => moduleKey)),
    [enrollmentBrand]: true as const,
    identities,
    owners: Object.freeze(owners),
    trustRoutines: trustRoutinesForIdentities(identities),
  });
};
