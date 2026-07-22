// @effect-diagnostics asyncFunction:off
import { rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  getStatusOptionDeletionImpactPayloadSchema,
  statusOptionDeletionImpactSchema,
} from '../../shared/status-option-deletion-impact.ts';
import type {
  GetStatusOptionDeletionImpactPayload,
  StatusOptionDeletionImpact,
} from '../../shared/status-option-deletion-impact.ts';
import { getStatusOptionDeletionImpactState } from '../status-option-deletion-impact.ts';

interface StatusOptionMetadataRow {
  readonly definitionRevision: number;
  readonly optionId: string;
  readonly optionRevision: number;
  readonly propertyDefinitionId: string;
}

export const getStatusOptionDeletionImpactDataAccessRegistration: DataAccessRegistration<
  GetStatusOptionDeletionImpactPayload,
  StatusOptionDeletionImpact
> = {
  descriptor: {
    accessKind: 'read',
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    dataAccessKey: 'ticketing.statusOptionDeletionImpact.get',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.statusOptionDeletionImpact.get.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'status_option',
    transportRequestSchema: getStatusOptionDeletionImpactPayloadSchema,
    transportResponseSchema: statusOptionDeletionImpactSchema,
  },
  handler: async (input, { context, db }) => {
    const metadataResult = await db.execute(sql`
      select
        definition.revision as "definitionRevision",
        option.option_id as "optionId",
        option.revision as "optionRevision",
        option.property_definition_id as "propertyDefinitionId"
      from ticketing.status_options as option
      inner join ticketing.task_property_definitions as definition
        on definition.property_definition_id = option.property_definition_id
        and definition.tenant_id = option.tenant_id
        and definition.datatype = 'status'
      inner join ticketing.task_schemas as schema
        on schema.schema_id = definition.schema_id
        and schema.tenant_id = definition.tenant_id
      where option.option_id = ${input.optionId}
        and option.property_definition_id = ${input.propertyDefinitionId}
        and option.tenant_id = ${context.tenantId}
        and schema.collection_id = ${input.collectionId}
    `);
    const metadata = rowsFromResult<StatusOptionMetadataRow>(metadataResult).at(0);
    if (metadata === undefined) {
      throw new Error('Status Option was not found.');
    }
    return {
      ...metadata,
      ...(await getStatusOptionDeletionImpactState({
        db,
        optionId: input.optionId,
        propertyDefinitionId: input.propertyDefinitionId,
        tenantId: context.tenantId,
      })),
    };
  },
};
