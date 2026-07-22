// @effect-diagnostics asyncFunction:off
import { coreReferenceRegistry } from '@app/core-runtime';
import type { DataAccessRegistration } from '@app/core-runtime';
import {
  coreReferenceRequestSchema,
  coreReferenceResponseSchema,
} from '../../shared/core-reference.ts';
import type { CoreReferenceRequest, CoreReferenceResponse } from '../../shared/core-reference.ts';

export const coreReferenceDataAccessRegistration: DataAccessRegistration<
  CoreReferenceRequest,
  CoreReferenceResponse
> = {
  descriptor: {
    accessKind: 'read',
    auditProfile: 'sensitive',
    dataAccessKey: 'core.reference.execute',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'core.reference.execute.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'core',
    targetModuleKey: 'core',
    targetResourceType: 'core_reference',
    transportRequestSchema: coreReferenceRequestSchema,
    transportResponseSchema: coreReferenceResponseSchema,
  },
  handler: async (input, { context }) => {
    const referenceContext = {
      principalId: context.principalId,
      tenantId: context.tenantId,
    };
    switch (input.operation) {
      case 'discover': {
        return {
          operation: 'discover',
          references: await coreReferenceRegistry.discover({
            context: referenceContext,
            query: input.query,
          }),
        };
      }
      case 'insert': {
        return {
          operation: 'insert',
          result: await coreReferenceRegistry.insert({
            context: referenceContext,
            kind: input.kind,
            source: input.source,
          }),
        };
      }
      case 'resolve': {
        return {
          operation: 'resolve',
          result: await coreReferenceRegistry.resolve({
            context: referenceContext,
            reference: input.reference,
          }),
        };
      }
      case 'open': {
        return {
          operation: 'open',
          result: await coreReferenceRegistry.open({
            context: referenceContext,
            reference: input.reference,
          }),
        };
      }
      default: {
        return input satisfies never;
      }
    }
  },
};
