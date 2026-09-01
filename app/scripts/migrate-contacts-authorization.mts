/* eslint-disable promise/prefer-await-to-callbacks -- The Authzed client exposes Promise APIs. */
import { pathToFileURL } from 'node:url';
import { v1 } from '@authzed/authzed-node';
import { Effect } from 'effect';
import { Pool } from 'pg';
import { loadDatabaseConnectionPair } from '../packages/core-runtime/src/db/config.ts';
import {
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../packages/core-runtime/src/permissions/context-access.ts';
import {
  fullyConsistent,
  spiceDbClientSecurity,
} from '../packages/core-runtime/src/permissions/client.ts';
import { loadSpiceDbConfig } from '../packages/core-runtime/src/permissions/config.ts';

const LEGACY_MODULE_ID = 'crm.core';
const CONTACTS_MODULE_ID = 'contacts.core';
const MAX_CONTEXTS = 500;
const MAX_PRINCIPALS = 5_000;
const MAX_RELATIONSHIPS_PER_CONTEXT = 100;
const DENIED_PROBE_PRINCIPAL_ID = 'contacts-identity-migration-denied-probe';

export type ContactsAuthorizationMigrationMode = 'finalize' | 'prepare' | 'verify';

export interface ContactsAuthorizationRelationship {
  readonly relation: 'accessor' | 'legal_entity';
  readonly subjectId: string;
  readonly subjectType: 'legal_entity' | 'principal';
}

export interface ContactsAuthorizationContextPlan {
  readonly deleteLegacy: boolean;
  readonly state: 'already_finalized' | 'already_prepared' | 'legacy_only' | 'unconfigured';
  readonly touchContacts: boolean;
}

const relationshipKey = (relationship: ContactsAuthorizationRelationship): string =>
  `${relationship.relation}\0${relationship.subjectType}\0${relationship.subjectId}`;

const sameRelationshipSet = (
  left: readonly ContactsAuthorizationRelationship[],
  right: readonly ContactsAuthorizationRelationship[],
): boolean => {
  const leftKeys = new Set(left.map(relationshipKey));
  const rightKeys = new Set(right.map(relationshipKey));
  return leftKeys.size === rightKeys.size && [...leftKeys].every((key) => rightKeys.has(key));
};

export const planContactsAuthorizationContext = (
  mode: ContactsAuthorizationMigrationMode,
  legacy: readonly ContactsAuthorizationRelationship[],
  contacts: readonly ContactsAuthorizationRelationship[],
): ContactsAuthorizationContextPlan => {
  if (legacy.length === 0 && contacts.length === 0) {
    return { deleteLegacy: false, state: 'unconfigured', touchContacts: false };
  }
  if (legacy.length === 0) {
    return { deleteLegacy: false, state: 'already_finalized', touchContacts: false };
  }
  if (contacts.length === 0) {
    if (mode !== 'prepare') {
      throw new Error('Contacts authorization is missing while legacy authorization still exists');
    }
    return { deleteLegacy: false, state: 'legacy_only', touchContacts: true };
  }
  if (!sameRelationshipSet(legacy, contacts)) {
    throw new Error('Legacy and Contacts authorization relationships differ');
  }
  return {
    deleteLegacy: mode === 'finalize',
    state: 'already_prepared',
    touchContacts: false,
  };
};

interface DatabaseContextRow {
  readonly legal_entity_id: string;
  readonly module_key: string;
  readonly tenant_id: string;
}

interface PrincipalRow {
  readonly principal_id: string;
  readonly status: string;
  readonly tenant_id: string;
}

interface AuthoritativeContext {
  readonly activePrincipalIds: ReadonlySet<string>;
  readonly legalEntityId: string;
  readonly tenantId: string;
}

const loadAuthoritativeContexts = async (
  connectionString: string,
): Promise<AuthoritativeContext[]> => {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const contextResult = await pool.query<DatabaseContextRow>(
      `select
         legal_entity.legal_entity_id::text,
         module_state.module_key,
         module_state.tenant_id::text
       from core.tenant_module_states as module_state
       join core.legal_entities as legal_entity
         on legal_entity.tenant_id = module_state.tenant_id
       where module_state.module_key in ($1, $2)
       order by module_state.tenant_id, legal_entity.legal_entity_id
       limit $3`,
      [LEGACY_MODULE_ID, CONTACTS_MODULE_ID, MAX_CONTEXTS + 1],
    );
    if (contextResult.rows.length > MAX_CONTEXTS) {
      throw new Error(`Authorization migration exceeds the ${MAX_CONTEXTS}-context safety bound`);
    }
    if (contextResult.rows.some((row) => row.module_key === LEGACY_MODULE_ID)) {
      throw new Error(
        'Core module identity migration must complete before authorization migration',
      );
    }
    const tenantIds = [...new Set(contextResult.rows.map((row) => row.tenant_id))];
    if (tenantIds.length === 0) return [];
    const principalResult = await pool.query<PrincipalRow>(
      `select principal_id::text, status, tenant_id::text
       from core.principals
       where tenant_id = any($1::uuid[])
       order by tenant_id, principal_id
       limit $2`,
      [tenantIds, MAX_PRINCIPALS + 1],
    );
    if (principalResult.rows.length > MAX_PRINCIPALS) {
      throw new Error(
        `Authorization migration exceeds the ${MAX_PRINCIPALS}-principal safety bound`,
      );
    }
    const activePrincipalsByTenant = new Map<string, Set<string>>();
    for (const principal of principalResult.rows) {
      if (principal.status !== 'active') continue;
      const ids = activePrincipalsByTenant.get(principal.tenant_id) ?? new Set<string>();
      ids.add(principal.principal_id);
      activePrincipalsByTenant.set(principal.tenant_id, ids);
    }
    return contextResult.rows.map((row) => ({
      activePrincipalIds: activePrincipalsByTenant.get(row.tenant_id) ?? new Set<string>(),
      legalEntityId: row.legal_entity_id,
      tenantId: row.tenant_id,
    }));
  } finally {
    await pool.end();
  }
};

const readRelationships = async (
  client: ReturnType<typeof v1.NewClient>,
  resourceId: string,
  context: AuthoritativeContext,
): Promise<ContactsAuthorizationRelationship[]> => {
  const responses = await client.promises.readRelationships(
    v1.ReadRelationshipsRequest.create({
      consistency: fullyConsistent,
      optionalLimit: MAX_RELATIONSHIPS_PER_CONTEXT + 1,
      relationshipFilter: v1.RelationshipFilter.create({
        optionalResourceId: resourceId,
        resourceType: 'module_access',
      }),
    }),
  );
  if (responses.length > MAX_RELATIONSHIPS_PER_CONTEXT) {
    throw new Error('A module-access context exceeds the relationship safety bound');
  }
  const legalEntityObjectId = toLegalEntityAccessObjectId(context.tenantId, context.legalEntityId);
  if (legalEntityObjectId === undefined)
    throw new Error('Invalid authoritative legal-entity context');
  return responses.map(({ relationship }) => {
    const subject = relationship?.subject;
    const subjectId = subject?.object?.objectId ?? '';
    const subjectType = subject?.object?.objectType;
    const relation = relationship?.relation;
    const isLegalEntity =
      relation === 'legal_entity' &&
      subjectType === 'legal_entity' &&
      subjectId === legalEntityObjectId;
    const isAccessor =
      relation === 'accessor' &&
      subjectType === 'principal' &&
      context.activePrincipalIds.has(subjectId);
    if (
      relationship?.resource?.objectId !== resourceId ||
      relationship.resource.objectType !== 'module_access' ||
      relationship.optionalCaveat !== undefined ||
      relationship.optionalExpiresAt !== undefined ||
      subject?.optionalRelation !== '' ||
      (!isLegalEntity && !isAccessor)
    ) {
      throw new Error('A module-access relationship is outside the authoritative context');
    }
    return {
      relation: relation as ContactsAuthorizationRelationship['relation'],
      subjectId,
      subjectType: subjectType as ContactsAuthorizationRelationship['subjectType'],
    };
  });
};

const toRelationship = (
  resourceId: string,
  item: ContactsAuthorizationRelationship,
): v1.Relationship =>
  v1.Relationship.create({
    relation: item.relation,
    resource: v1.ObjectReference.create({ objectId: resourceId, objectType: 'module_access' }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({
        objectId: item.subjectId,
        objectType: item.subjectType,
      }),
    }),
  });

const writeRelationships = async (
  client: ReturnType<typeof v1.NewClient>,
  operation: v1.RelationshipUpdate_Operation,
  resourceId: string,
  relationships: readonly ContactsAuthorizationRelationship[],
): Promise<void> => {
  if (relationships.length === 0) return;
  await client.promises.writeRelationships(
    v1.WriteRelationshipsRequest.create({
      updates: relationships.map((item) =>
        v1.RelationshipUpdate.create({
          operation,
          relationship: toRelationship(resourceId, item),
        }),
      ),
    }),
  );
};

const assertContactsPermissions = async (
  client: ReturnType<typeof v1.NewClient>,
  resourceId: string,
  relationships: readonly ContactsAuthorizationRelationship[],
): Promise<void> => {
  const accessorIds = relationships
    .filter((item) => item.relation === 'accessor')
    .map((item) => item.subjectId);
  for (const principalId of accessorIds) {
    const response = await client.promises.checkPermission(
      v1.CheckPermissionRequest.create({
        consistency: fullyConsistent,
        permission: 'access',
        resource: v1.ObjectReference.create({ objectId: resourceId, objectType: 'module_access' }),
        subject: v1.SubjectReference.create({
          object: v1.ObjectReference.create({ objectId: principalId, objectType: 'principal' }),
        }),
      }),
    );
    if (response.permissionship !== v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION) {
      throw new Error('Contacts permission verification did not preserve an allowed principal');
    }
  }
  const deniedResponse = await client.promises.checkPermission(
    v1.CheckPermissionRequest.create({
      consistency: fullyConsistent,
      permission: 'access',
      resource: v1.ObjectReference.create({ objectId: resourceId, objectType: 'module_access' }),
      subject: v1.SubjectReference.create({
        object: v1.ObjectReference.create({
          objectId: DENIED_PROBE_PRINCIPAL_ID,
          objectType: 'principal',
        }),
      }),
    }),
  );
  if (deniedResponse.permissionship !== v1.CheckPermissionResponse_Permissionship.NO_PERMISSION) {
    throw new Error('Contacts permission verification did not preserve the denied boundary');
  }
};

const parseMode = (value: string | undefined): ContactsAuthorizationMigrationMode => {
  if (value === 'prepare' || value === 'verify' || value === 'finalize') return value;
  throw new Error(
    'Expected exactly one authorization migration mode: prepare, verify, or finalize',
  );
};

export const migrateContactsAuthorization = async (
  mode: ContactsAuthorizationMigrationMode,
): Promise<{ readonly contexts: number; readonly deleted: number; readonly touched: number }> => {
  const [database, spiceDb] = await Promise.all([
    Effect.runPromise(loadDatabaseConnectionPair()),
    Effect.runPromise(loadSpiceDbConfig()),
  ]);
  const contexts = await loadAuthoritativeContexts(database.admin.connectionString);
  const client = v1.NewClient(
    spiceDb.preSharedKey,
    spiceDb.endpoint,
    spiceDbClientSecurity(spiceDb),
  );
  let deleted = 0;
  let touched = 0;
  try {
    for (const context of contexts) {
      const legacyResourceId = toModuleAccessObjectId(
        context.tenantId,
        context.legalEntityId,
        LEGACY_MODULE_ID,
      );
      const contactsResourceId = toModuleAccessObjectId(
        context.tenantId,
        context.legalEntityId,
        CONTACTS_MODULE_ID,
      );
      if (legacyResourceId === undefined || contactsResourceId === undefined) {
        throw new Error('Invalid authoritative module-access context');
      }
      const [legacy, contactsBefore] = await Promise.all([
        readRelationships(client, legacyResourceId, context),
        readRelationships(client, contactsResourceId, context),
      ]);
      const plan = planContactsAuthorizationContext(mode, legacy, contactsBefore);
      if (plan.touchContacts) {
        await writeRelationships(
          client,
          v1.RelationshipUpdate_Operation.TOUCH,
          contactsResourceId,
          legacy,
        );
        touched += legacy.length;
      }
      const contactsAfter = await readRelationships(client, contactsResourceId, context);
      if (legacy.length > 0 && !sameRelationshipSet(legacy, contactsAfter)) {
        throw new Error('Contacts relationship verification failed after preparation');
      }
      if (contactsAfter.length > 0) {
        await assertContactsPermissions(client, contactsResourceId, contactsAfter);
      }
      if (plan.deleteLegacy) {
        await writeRelationships(
          client,
          v1.RelationshipUpdate_Operation.DELETE,
          legacyResourceId,
          legacy,
        );
        deleted += legacy.length;
        const remainingLegacy = await readRelationships(client, legacyResourceId, context);
        if (remainingLegacy.length > 0)
          throw new Error('Legacy relationship cleanup was incomplete');
      }
    }
    return { contexts: contexts.length, deleted, touched };
  } finally {
    client.close();
  }
};

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const mode = parseMode(process.argv[2]);
  if (process.argv.length !== 3) throw new Error('Authorization migration accepts one mode only');
  const result = await migrateContactsAuthorization(mode);
  console.log(
    `Contacts authorization ${mode} completed (${result.contexts} contexts, ${result.touched} touched, ${result.deleted} deleted)`,
  );
}
