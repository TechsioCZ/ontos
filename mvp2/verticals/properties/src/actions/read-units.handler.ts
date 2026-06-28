// @effect-diagnostics asyncFunction:off
import type { ActionExecutionServices } from '@mvp2/core-runtime';
import { dataAccessEvents } from '@mvp2/core-runtime/db/schema';
import { asc } from 'drizzle-orm';
import { unit } from '../db/schema.ts';
import type { ReadUnitsAction } from './read-units.action.ts';

export interface ReadUnitResult {
  readonly createdAt: string;
  readonly name: string;
  readonly unitId: string;
}

export type ReadUnitsResult = readonly ReadUnitResult[];

export const readUnitsHandler = async (
  _input: ReadUnitsAction,
  services: ActionExecutionServices<ReadUnitsAction>,
): Promise<ReadUnitsResult> => {
  const rows = await services.tx
    .select({
      createdAt: unit.createdAt,
      name: unit.name,
      unitId: unit.unitId,
    })
    .from(unit)
    .orderBy(asc(unit.createdAt), asc(unit.unitId));

  await services.tx.insert(dataAccessEvents).values({
    accessKind: 'list',
    actionInvocationId: services.context.actionInvocation?.actionInvocationId,
    authMethod: 'session',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'property.registry.readUnits.metadataOnly',
    legalEntityId: services.context.legalEntityId,
    principalId: services.context.principalId,
    queryHash: services.context.actionInvocation?.requestHash ?? 'read-units',
    resultCount: rows.length,
    servingModuleKey: 'properties',
    targetModuleKey: 'properties',
    targetResourceType: 'property.unit',
    tenantId: services.context.tenantId,
  });

  return rows.map((row) => ({
    createdAt: row.createdAt.toISOString(),
    name: row.name,
    unitId: row.unitId,
  }));
};
