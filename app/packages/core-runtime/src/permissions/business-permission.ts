import { Predicate, Result, Schema } from 'effect';

const dottedPermissionPattern = /^(?:retail|counterparty)(?:\.[a-z][a-z0-9_]*)+$/u;
const dottedEntrypointPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9_-]*)+$/u;
const schemaVersionPattern = /^[1-9][0-9]*$/u;
const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const BusinessPermissionCodeSchema = Schema.String.check(
  Schema.isPattern(dottedPermissionPattern),
).pipe(Schema.brand('BusinessPermissionCode'), Schema.decodeTo(Schema.String));

export const BusinessPermissionScopeKindSchema = Schema.Literals([
  'counterparty',
  'counterparty_storefront',
  'retail_profile',
]);
export const BusinessPermissionAuditSensitivitySchema = Schema.Literals(['sensitive', 'standard']);

export type BusinessPermissionCode = typeof BusinessPermissionCodeSchema.Type;
export type BusinessPermissionScopeKind = typeof BusinessPermissionScopeKindSchema.Type;
export type BusinessPermissionAuditSensitivity =
  typeof BusinessPermissionAuditSensitivitySchema.Type;

export const BusinessPermissionDescriptorSchema = Schema.Struct({
  allowedScopeKinds: Schema.Array(BusinessPermissionScopeKindSchema),
  auditSensitivity: BusinessPermissionAuditSensitivitySchema,
  authorityGroups: Schema.Array(nonEmptyString),
  customerDelegable: Schema.Boolean,
  internalGrantable: Schema.Boolean,
  key: BusinessPermissionCodeSchema,
  meaning: nonEmptyString,
  owningCapability: nonEmptyString,
  protectedEntrypoints: Schema.Array(
    Schema.String.check(Schema.isPattern(dottedEntrypointPattern)),
  ),
  schemaVersion: Schema.String.check(Schema.isPattern(schemaVersionPattern)),
});

export type BusinessPermissionDescriptor = typeof BusinessPermissionDescriptorSchema.Type;

const BusinessPermissionCatalogInputSchema = Schema.Struct({
  authorityGroups: Schema.Record(Schema.String, Schema.Array(BusinessPermissionCodeSchema)),
  catalogVersion: Schema.String.check(Schema.isPattern(schemaVersionPattern)),
  permissions: Schema.Array(BusinessPermissionDescriptorSchema),
});

export type BusinessPermissionCatalog = Readonly<typeof BusinessPermissionCatalogInputSchema.Type>;

class BusinessPermissionCatalogInvariantError extends Schema.TaggedError<BusinessPermissionCatalogInvariantError>()(
  'BusinessPermissionCatalogInvariantError',
  { message: Schema.String },
) {}

const invalid = (message: string): never => {
  throw new BusinessPermissionCatalogInvariantError({ message });
};

const freezeDescriptor = (
  descriptor: BusinessPermissionDescriptor,
): Readonly<BusinessPermissionDescriptor> =>
  Object.freeze({
    ...descriptor,
    allowedScopeKinds: Object.freeze([...descriptor.allowedScopeKinds]),
    authorityGroups: Object.freeze([...descriptor.authorityGroups]),
    protectedEntrypoints: Object.freeze([...descriptor.protectedEntrypoints]),
  });

export const defineBusinessPermission = (
  input: BusinessPermissionDescriptor,
): Readonly<BusinessPermissionDescriptor> => {
  const descriptor = Result.getOrThrow(
    Schema.decodeUnknownResult(BusinessPermissionDescriptorSchema, {
      onExcessProperty: 'error',
    })(input),
  );
  if (new Set(descriptor.allowedScopeKinds).size !== descriptor.allowedScopeKinds.length) {
    return invalid(`business permission ${descriptor.key} repeats an allowed scope kind`);
  }
  if (descriptor.allowedScopeKinds.length === 0) {
    return invalid(`business permission ${descriptor.key} must allow at least one scope kind`);
  }
  for (const values of [descriptor.authorityGroups, descriptor.protectedEntrypoints]) {
    if (new Set(values).size !== values.length) {
      return invalid(`business permission ${descriptor.key} contains duplicate catalog metadata`);
    }
  }
  return freezeDescriptor(descriptor);
};

export const defineBusinessPermissionCatalog = (input: {
  readonly authorityGroups: Readonly<Record<string, readonly BusinessPermissionCode[]>>;
  readonly catalogVersion: string;
  readonly permissions: readonly BusinessPermissionDescriptor[];
}): BusinessPermissionCatalog => {
  if (!Predicate.isObjectKeyword(input) || input === null) {
    return invalid('business permission catalog must be an object');
  }
  const decoded = Result.getOrThrow(
    Schema.decodeUnknownResult(BusinessPermissionCatalogInputSchema, {
      onExcessProperty: 'error',
    })(input),
  );
  const permissions = decoded.permissions.map(defineBusinessPermission);
  const byKey = new Map(permissions.map((permission) => [permission.key, permission]));
  if (byKey.size !== permissions.length) {
    return invalid('business permission catalog contains a duplicate permission code');
  }
  const authorityGroups = Object.fromEntries(
    Object.entries(decoded.authorityGroups).map(([group, entries]) => {
      if (group.trim().length === 0 || new Set(entries).size !== entries.length) {
        return invalid('business permission authority groups require a name and unique entries');
      }
      for (const permission of entries) {
        const descriptor = byKey.get(permission);
        if (descriptor === undefined || !descriptor.authorityGroups.includes(group)) {
          return invalid(
            `authority group ${group} and permission ${permission} must declare each other`,
          );
        }
      }
      return [group, Object.freeze([...entries])] as const;
    }),
  );
  for (const permission of permissions) {
    for (const group of permission.authorityGroups) {
      const entries = authorityGroups[group];
      if (entries === undefined || !entries.includes(permission.key)) {
        return invalid(
          `business permission ${permission.key} references undeclared authority group ${group}`,
        );
      }
    }
  }
  return Object.freeze({
    authorityGroups: Object.freeze(authorityGroups),
    catalogVersion: decoded.catalogVersion,
    permissions: Object.freeze(permissions),
  });
};

export const isBusinessPermissionDescriptor = Schema.is(BusinessPermissionDescriptorSchema);
