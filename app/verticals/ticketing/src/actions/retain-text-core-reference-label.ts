// @effect-diagnostics asyncFunction:off
import { coreReferenceRegistry, rejectAction, rowsFromResult } from '@app/core-runtime';
import type {
  ActionAuditEventDescriptor,
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  retainTextCoreReferenceLabelActionKey,
  retainTextCoreReferenceLabelActionPayloadSchema,
  retainTextCoreReferenceLabelActionResponseSchema,
} from '../../shared/actions/retain-text-core-reference-label.ts';
import type {
  RetainTextCoreReferenceLabelActionPayload,
  RetainTextCoreReferenceLabelActionResponse,
} from '../../shared/actions/retain-text-core-reference-label.ts';
import type { CoreReference, TextDocument } from '../../shared/text-property.ts';
import { normalizeTextDocument } from '../text-property-document.ts';

interface CurrentTextValueRow {
  readonly document: TextDocument | null;
}

const referenceIdentityKey = (reference: CoreReference): string =>
  JSON.stringify([
    reference.ownerModuleKey,
    reference.targetTenantId,
    reference.entityType,
    reference.entityId,
    reference.token,
    reference.kind,
  ]);

const retentionEvidence = (
  input: RetainTextCoreReferenceLabelActionPayload,
  response: RetainTextCoreReferenceLabelActionResponse,
) => ({
  changedComponents: ['textReferenceLabelProjection'],
  collectionId: input.collectionId,
  operation: 'refreshed',
  propertyDefinitionId: response.propertyDefinitionId,
  taskId: response.taskId,
});

const auditEvent = {
  evidence: retentionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  RetainTextCoreReferenceLabelActionPayload,
  RetainTextCoreReferenceLabelActionResponse
>;

const domainEvent = {
  eventType: 'ticketing.textCoreReferenceLabelProjection.refreshed',
  payload: retentionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  RetainTextCoreReferenceLabelActionPayload,
  RetainTextCoreReferenceLabelActionResponse
>;

const handler: ActionHandler<
  RetainTextCoreReferenceLabelActionPayload,
  RetainTextCoreReferenceLabelActionResponse
> = async (input, services) => {
  const currentResult = await services.tx.execute(sql`
    select value.document
    from ticketing.task_text_values as value
    inner join ticketing.tasks as task
      on task.task_id = value.task_id
      and task.tenant_id = value.tenant_id
    inner join ticketing.task_property_definitions as definition
      on definition.property_definition_id = value.property_definition_id
      and definition.tenant_id = value.tenant_id
      and definition.datatype = 'text'
    where value.task_id = ${input.taskId}
      and value.property_definition_id = ${input.propertyDefinitionId}
      and value.tenant_id = ${services.context.tenantId}
      and task.collection_id = ${input.collectionId}
    for update of value
  `);
  const current = rowsFromResult<CurrentTextValueRow>(currentResult).at(0);
  if (current === undefined) {
    throw rejectAction({
      code: 'ticketing.retainTextCoreReferenceLabel.missing_value',
      message: 'The Text value is no longer available.',
    });
  }

  const identity = referenceIdentityKey(input.reference);
  const storedReference = current.document?.content.find(
    (node) => node.type === 'reference' && referenceIdentityKey(node.reference) === identity,
  );
  if (storedReference?.type !== 'reference') {
    services.markNoOp();
    return {
      changed: false,
      propertyDefinitionId: input.propertyDefinitionId,
      taskId: input.taskId,
    };
  }

  const resolution = await coreReferenceRegistry.resolve({
    context: {
      principalId: services.context.principalId,
      tenantId: services.context.tenantId,
    },
    reference: storedReference.reference,
  });
  if (
    resolution._tag !== 'CoreReferenceActive' ||
    resolution.reference.lastResolvedLabel === storedReference.reference.lastResolvedLabel
  ) {
    services.markNoOp();
    return {
      changed: false,
      propertyDefinitionId: input.propertyDefinitionId,
      taskId: input.taskId,
    };
  }

  const document: TextDocument = {
    ...current.document,
    content: current.document.content.map((node) =>
      node.type === 'reference' && referenceIdentityKey(node.reference) === identity
        ? { ...node, reference: resolution.reference }
        : node,
    ),
  };
  const normalized = normalizeTextDocument(document);
  await services.tx.execute(sql`
    update ticketing.task_text_values
    set
      document = ${JSON.stringify(normalized.document)}::jsonb,
      readable_text = ${normalized.readableText}
    where task_id = ${input.taskId}
      and property_definition_id = ${input.propertyDefinitionId}
      and tenant_id = ${services.context.tenantId}
  `);

  return { changed: true, propertyDefinitionId: input.propertyDefinitionId, taskId: input.taskId };
};

export const retainTextCoreReferenceLabelActionRegistration: ActionRegistration<
  RetainTextCoreReferenceLabelActionPayload,
  RetainTextCoreReferenceLabelActionResponse
> = {
  descriptor: {
    actionKey: retainTextCoreReferenceLabelActionKey,
    auditEvent,
    auditProfile: 'sensitive',
    authorization: {
      permission: 'view_task_properties',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'optional',
    moduleStateAccess: 'mutate',
    transportRequestSchema: retainTextCoreReferenceLabelActionPayloadSchema,
    transportResponseSchema: retainTextCoreReferenceLabelActionResponseSchema,
  },
  handler,
};
