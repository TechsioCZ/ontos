import { Option, Result, Schema } from 'effect';

/** Owner-neutral identity contracts, safe to load from build and migration configuration. */
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

export class DatabaseIdentityEnrollmentError extends Schema.TaggedError<DatabaseIdentityEnrollmentError>()(
  'DatabaseIdentityEnrollmentError',
  { cause: Schema.optionalKey(Schema.Unknown), reason: Schema.String },
) {}

const freezeIdentity = (identity: DatabaseIdentity): DatabaseIdentity =>
  Object.freeze({
    ...identity,
    cloudflareHyperdrive:
      identity.cloudflareHyperdrive === null ? null : Object.freeze({ ...identity.cloudflareHyperdrive }),
    gatewayScopeAudiences: Object.freeze([...identity.gatewayScopeAudiences]),
  });

export const SHARED_RUNTIME_IDENTITY: DatabaseIdentity = freezeIdentity({
  cloudflareHyperdrive: { binding: 'HYPERDRIVE', idVariable: 'ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID' },
  gatewayScopeAudiences: [],
  handlesBearerAssertions: false,
  id: 'shared_runtime',
  ownerModuleKey: null,
  registersGatewayScopeGrants: false,
  role: 'ontos_runtime',
  scopeAuthority: 'session_setting',
  urlKey: 'DATABASE_URL',
});
export const SHELL_GATEWAY_ISSUER_IDENTITY: DatabaseIdentity = freezeIdentity({
  cloudflareHyperdrive: {
    binding: 'GATEWAY_ISSUER_HYPERDRIVE',
    idVariable: 'ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID',
  },
  gatewayScopeAudiences: [],
  handlesBearerAssertions: true,
  id: 'shell_gateway_issuer',
  ownerModuleKey: null,
  registersGatewayScopeGrants: true,
  role: 'shell_gateway_issuer',
  scopeAuthority: 'none',
  urlKey: 'SHELL_GATEWAY_ISSUER_DATABASE_URL',
});
export const BEARER_ASSERTION_ROLE_SETTINGS = Object.freeze([
  'log_parameter_max_length=0',
  'log_parameter_max_length_on_error=0',
] as const);

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

const IdentifierSchema = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,62}$/u)));
const VariableSchema = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u)));
const ModuleKeySchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u)),
  Schema.brand('DatabaseOwnerModuleKey'),
);
const AudienceSchema = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)));
const IdentitySchema = Schema.Struct({
  cloudflareHyperdrive: Schema.OptionFromNullOr(Schema.Struct({ binding: VariableSchema, idVariable: VariableSchema })),
  gatewayScopeAudiences: Schema.Array(AudienceSchema),
  handlesBearerAssertions: Schema.Boolean,
  id: IdentifierSchema,
  ownerModuleKey: Schema.OptionFromNullOr(ModuleKeySchema),
  registersGatewayScopeGrants: Schema.Boolean,
  role: IdentifierSchema,
  scopeAuthority: Schema.Literals(DATABASE_SCOPE_AUTHORITIES),
  urlKey: VariableSchema.pipe(Schema.brand('DatabaseUrlKey')),
});
const DescriptorSchema = Schema.Struct({
  moduleKey: ModuleKeySchema,
  policyPrefix: IdentifierSchema,
  request: IdentitySchema,
  schemas: Schema.Array(IdentifierSchema),
  worker: IdentitySchema,
});
const decodeDescriptors = Schema.decodeUnknownResult(Schema.Array(DescriptorSchema), { onExcessProperty: 'error' });
const freezeDecodedIdentity = (identity: typeof IdentitySchema.Type): DatabaseIdentity =>
  freezeIdentity({
    ...identity,
    cloudflareHyperdrive: Option.getOrNull(identity.cloudflareHyperdrive),
    ownerModuleKey: Option.getOrNull(identity.ownerModuleKey),
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
  const decoded = Result.getOrThrow(
    decodeDescriptors(descriptors).pipe(
      Result.mapError(
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
