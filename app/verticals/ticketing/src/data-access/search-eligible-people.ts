// @effect-diagnostics asyncFunction:off
import { rowsFromResult, searchEligiblePeople } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  searchEligiblePeoplePayloadSchema,
  searchEligiblePeopleResponseSchema,
} from '../../shared/person-directory-search.ts';
import type {
  SearchEligiblePeoplePayload,
  SearchEligiblePeopleResponse,
} from '../../shared/person-directory-search.ts';

export const searchEligiblePeopleDataAccessRegistration: DataAccessRegistration<
  SearchEligiblePeoplePayload,
  SearchEligiblePeopleResponse
> = {
  descriptor: {
    accessKind: 'search',
    auditProfile: 'sensitive',
    authorization: {
      permission: 'view_task_properties',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    dataAccessKey: 'core.personDirectory.eligible.search',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'core.personDirectory.eligible.search.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'core',
    targetModuleKey: 'core',
    targetResourceType: 'person_directory',
    transportRequestSchema: searchEligiblePeoplePayloadSchema,
    transportResponseSchema: searchEligiblePeopleResponseSchema,
  },
  handler: async (input, { context, db }) => {
    const collectionResult = await db.execute(sql`
      select collection_id
      from ticketing.task_collections
      where collection_id = ${input.collectionId}
        and tenant_id = ${context.tenantId}
    `);
    if (rowsFromResult(collectionResult).length === 0) {
      throw new Error('Task Collection was not found.');
    }
    return {
      people: await searchEligiblePeople({ context, db, query: input.query }),
    };
  },
};
