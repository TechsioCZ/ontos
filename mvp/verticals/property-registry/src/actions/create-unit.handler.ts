// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import type { RuntimeActionHandler } from '@mvp/core-runtime';
import { randomBytes } from 'node:crypto';
import { createPropertyUnitProof } from '../db/property-queries.ts';
import type { PropertyUnitCreatePayload, PropertyUnitCreateResult } from './create-unit.action.ts';

const slugCode = (displayName: string): string => {
  const slug = displayName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-|-$/gu, '');

  return slug.length === 0 ? 'day4-unit' : slug;
};

const unitCodeWithRandomSuffix = (displayName: string): string =>
  `${slugCode(displayName)}-${randomBytes(4).toString('hex')}`;

export const createUnitHandler: RuntimeActionHandler<
  PropertyUnitCreatePayload,
  PropertyUnitCreateResult
> = async ({ context, db, payload }) => {
  const created = await createPropertyUnitProof(db, {
    code: unitCodeWithRandomSuffix(payload.displayName),
    context,
    ...(payload.floorLabel === undefined ? {} : { floorLabel: payload.floorLabel }),
  });

  return {
    actionId: 'property.registry.createUnit',
    didWriteCanonicalRows: true,
    moduleId: 'property.registry',
    resourceId: 'property.unit',
    resourceRef: created.resourceRef,
    status: 'created',
    unitId: created.unitId,
  } satisfies PropertyUnitCreateResult;
};
