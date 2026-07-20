// @effect-diagnostics asyncFunction:off
import { rejectAction } from '@app/core-runtime';
import type {
  ActionAuditEventDescriptor,
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import {
  duplicateTaskPropertyDefinitionActionKey,
  duplicateTaskPropertyDefinitionActionPayloadSchema,
  duplicateTaskPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/duplicate-task-property-definition.ts';
import type {
  DuplicateTaskPropertyDefinitionActionPayload,
  DuplicateTaskPropertyDefinitionActionResponse,
} from '../../shared/actions/duplicate-task-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';
import {
  duplicateTaskPropertyDefinition,
  lockTaskPropertyDefinitionLifecycleTarget,
} from '../task-property-definition-lifecycle.ts';

const duplicatedDefinitionEvidence = (
  input: DuplicateTaskPropertyDefinitionActionPayload,
  response: DuplicateTaskPropertyDefinitionActionResponse,
) => ({
  changedComponents: ['definition', 'propertyValues'],
  collectionId: input.collectionId,
  copiedValues: input.copyValues,
  datatype: response.definition.datatype,
  operation: 'duplicated',
  propertyDefinitionId: response.definition.propertyDefinitionId,
  revision: response.definition.revision,
  sourcePropertyDefinitionId: input.propertyDefinitionId,
});

const duplicateTaskPropertyDefinitionAuditEvent = {
  evidence: duplicatedDefinitionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.definition.propertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  DuplicateTaskPropertyDefinitionActionPayload,
  DuplicateTaskPropertyDefinitionActionResponse
>;

const duplicateTaskPropertyDefinitionDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.duplicated',
  payload: duplicatedDefinitionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.definition.propertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  DuplicateTaskPropertyDefinitionActionPayload,
  DuplicateTaskPropertyDefinitionActionResponse
>;

const duplicateTaskPropertyDefinitionActionHandler: ActionHandler<
  DuplicateTaskPropertyDefinitionActionPayload,
  DuplicateTaskPropertyDefinitionActionResponse
> = async (input, services) => {
  await lockTaskCollectionForPropertyInitialization({
    collectionId: input.collectionId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });

  const source = await lockTaskPropertyDefinitionLifecycleTarget({
    collectionId: input.collectionId,
    propertyDefinitionId: input.propertyDefinitionId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });
  if (source === undefined || source.revision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.duplicateTaskPropertyDefinition.stale_or_missing',
      message: 'The Task Property Definition changed elsewhere or is no longer available.',
    });
  }

  const definition = await duplicateTaskPropertyDefinition({
    copyValues: input.copyValues,
    source,
    tx: services.tx,
  });
  if (definition === undefined) {
    throw rejectAction({
      code: 'ticketing.duplicateTaskPropertyDefinition.stale_or_missing',
      message: 'The Task Property Definition changed elsewhere or is no longer available.',
    });
  }

  return { definition };
};

export const duplicateTaskPropertyDefinitionActionRegistration: ActionRegistration<
  DuplicateTaskPropertyDefinitionActionPayload,
  DuplicateTaskPropertyDefinitionActionResponse
> = {
  descriptor: {
    actionKey: duplicateTaskPropertyDefinitionActionKey,
    auditEvent: duplicateTaskPropertyDefinitionAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: duplicateTaskPropertyDefinitionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: duplicateTaskPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: duplicateTaskPropertyDefinitionActionResponseSchema,
  },
  handler: duplicateTaskPropertyDefinitionActionHandler,
};
