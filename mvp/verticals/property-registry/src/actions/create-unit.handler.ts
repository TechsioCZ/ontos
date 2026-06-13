import { Effect } from '@modern-js/plugin-bff/effect-client';
import type { PropertyUnitCreatePayload, PropertyUnitCreateResult } from './create-unit.action';

const slugUnitId = (displayName: string) =>
  `property.unit.fixture.${
    displayName
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, '-')
      .replaceAll(/^-|-$/gu, '') || 'unnamed'
  }`;

export const createUnitHandler = (payload: PropertyUnitCreatePayload) =>
  Effect.succeed({
    actionId: 'property.registry.createUnit',
    didWriteCanonicalRows: false,
    moduleId: 'property.registry',
    resourceId: 'property.unit',
    status: 'not_implemented',
    unitId: slugUnitId(payload.displayName),
  } satisfies PropertyUnitCreateResult);
