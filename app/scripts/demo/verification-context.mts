import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import { toSpiceDbActionObjectId } from '@app/core-runtime/actions/runtime-wiring';
import { Effect, Schema } from 'effect';

class VerificationContextInvalid extends Schema.TaggedError<VerificationContextInvalid>()(
  'VerificationContextInvalid',
  { reason: Schema.String },
) {}

const verificationName = 'Ověření připojení';
const taskModule = 'work.tasks';

/** Isolated infrastructure identity: no memberships or grants in any customer demo tenant. */
export const verificationAccount = {
  authBindingId: '74000000-0000-4000-8000-000000000090',
  authUserId: 'stage-verification',
  displayName: verificationName,
  email: 'verification@ci.ontos',
  principalId: '72000000-0000-4000-8000-000000000090',
} as const;
export const verificationTenantId = '70000000-0000-4000-8000-000000000090';
export const verificationLegalEntityId = '71000000-0000-4000-8000-000000000090';

export const verificationContext = Effect.fn('Demo.verificationContext')(function* verificationContext() {
  const { authBindingId, authUserId, displayName, principalId } = verificationAccount;
  const legal = toLegalEntityAccessObjectId(verificationTenantId, verificationLegalEntityId);
  if (legal === undefined) {
    return yield* new VerificationContextInvalid({ reason: 'Invalid verification company identity' });
  }
  const relationships = [
    {
      relation: 'member',
      resourceId: verificationTenantId,
      resourceType: 'tenant',
      subjectId: principalId,
      subjectType: 'principal',
    },
    {
      relation: 'tenant',
      resourceId: legal,
      resourceType: 'legal_entity',
      subjectId: verificationTenantId,
      subjectType: 'tenant',
    },
    {
      relation: 'member',
      resourceId: legal,
      resourceType: 'legal_entity',
      subjectId: principalId,
      subjectType: 'principal',
    },
  ];
  for (const moduleId of ['core.shell', taskModule]) {
    const resourceId = toModuleAccessObjectId(verificationTenantId, verificationLegalEntityId, moduleId);
    if (resourceId === undefined) {
      return yield* new VerificationContextInvalid({ reason: 'Invalid verification module identity' });
    }
    relationships.push(
      {
        relation: 'legal_entity',
        resourceId,
        resourceType: 'module_access',
        subjectId: legal,
        subjectType: 'legal_entity',
      },
      {
        relation: 'accessor',
        resourceId,
        resourceType: 'module_access',
        subjectId: principalId,
        subjectType: 'principal',
      },
    );
  }
  for (const permission of ['work.tasks.read_all', 'work.tasks.write_all']) {
    const resourceId = toContextPermissionAccessObjectId(verificationTenantId, verificationLegalEntityId, {
      moduleId: taskModule,
      permission,
    });
    if (resourceId === undefined) {
      return yield* new VerificationContextInvalid({ reason: 'Invalid verification permission identity' });
    }
    relationships.push(
      {
        relation: 'tenant',
        resourceId,
        resourceType: 'context_permission',
        subjectId: verificationTenantId,
        subjectType: 'tenant',
      },
      {
        relation: 'grantee',
        resourceId,
        resourceType: 'context_permission',
        subjectId: principalId,
        subjectType: 'principal',
      },
    );
  }
  relationships.push({
    relation: 'executor',
    resourceId: toSpiceDbActionObjectId('work.tasks.apply-command'),
    resourceType: 'action',
    subjectId: principalId,
    subjectType: 'principal',
  });
  return {
    accounts: [{ authBindingId, authUserId, displayName, principalId }],
    legalEntity: {
      legalEntityId: verificationLegalEntityId,
      legalName: verificationName,
      registrationCountry: 'CZ',
      registrationNumber: 'CI-VERIFICATION',
    },
    modules: [{ moduleId: taskModule, stateId: '78000000-0000-4000-8000-000000000090' }],
    relationships,
    tenant: {
      defaultLocale: 'cs',
      displayName: verificationName,
      slug: 'ci-verification',
      tenantId: verificationTenantId,
    },
  };
});
