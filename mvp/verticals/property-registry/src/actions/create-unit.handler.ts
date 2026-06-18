// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import type { RuntimeActionHandler } from '@mvp/core-runtime';
import { randomBytes } from 'node:crypto';
import { createPropertyUnitProof } from '../db/property-queries.ts';
import type { PropertyUnitCreatePayload, PropertyUnitCreateResult } from './create-unit.action.ts';

const slugCode = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-|-$/gu, '');

  return slug.length === 0 ? 'day4-unit' : slug;
};

const unitCodeWithRandomSuffix = (name: string): string =>
  `${slugCode(name)}-${randomBytes(4).toString('hex')}`;

export const createUnitHandler: RuntimeActionHandler<
  PropertyUnitCreatePayload,
  PropertyUnitCreateResult
> = async ({ context, db, payload }) => {
  const created = await createPropertyUnitProof(db, {
    code: unitCodeWithRandomSuffix(payload.name),
    context,
    name: payload.name,
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
