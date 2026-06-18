// @effect-diagnostics asyncFunction:off globalDate:off
import { propertyBuildings, propertyProperties, propertyUnits } from '@mvp/core-runtime';
import type { CoreDb, PropertyUnitInsert, RuntimeContext } from '@mvp/core-runtime';

export interface CreatePropertyUnitProofInput {
  code: string;
  context: RuntimeContext;
  name: string;
}

export interface CreatePropertyUnitProofResult {
  unitId: string;
  resourceRef: {
    moduleId: 'property.registry';
    resourceId: 'property.unit';
    resourceKey: string;
  };
}

export const createPropertyUnitProof = async (
  db: CoreDb,
  input: CreatePropertyUnitProofInput,
): Promise<CreatePropertyUnitProofResult> => {
  const now = new Date();
  const [property] = await db
    .insert(propertyProperties)
    .values({
      addressJson: {},
      code: 'DAY4-DEMO-PROPERTY',
      createdAt: now,
      legalEntityId: input.context.legalEntity.legalEntityId,
      lifecycleState: 'active',
      name: 'Day 4 Demo Property',
      tenantId: input.context.tenant.tenantId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      set: {
        legalEntityId: input.context.legalEntity.legalEntityId,
        lifecycleState: 'active',
        name: 'Day 4 Demo Property',
        updatedAt: now,
      },
      target: [propertyProperties.tenantId, propertyProperties.code],
    })
    .returning({ propertyId: propertyProperties.propertyId });

  if (property === undefined) {
    throw new Error('Drizzle did not return the Day 4 demo property row.');
  }

  const [building] = await db
    .insert(propertyBuildings)
    .values({
      code: 'DAY4-DEMO-BUILDING',
      createdAt: now,
      lifecycleState: 'active',
      name: 'Day 4 Demo Building',
      propertyId: property.propertyId,
      tenantId: input.context.tenant.tenantId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      set: {
        lifecycleState: 'active',
        name: 'Day 4 Demo Building',
        updatedAt: now,
      },
      target: [propertyBuildings.tenantId, propertyBuildings.propertyId, propertyBuildings.code],
    })
    .returning({ buildingId: propertyBuildings.buildingId });

  if (building === undefined) {
    throw new Error('Drizzle did not return the Day 4 demo building row.');
  }

  const unitInsert = {
    areaM2: '42',
    buildingId: building.buildingId,
    code: input.code,
    createdAt: now,
    floorLabel: '1',
    lifecycleState: 'active',
    name: input.name,
    tenantId: input.context.tenant.tenantId,
    unitType: 'demo',
    updatedAt: now,
  } satisfies PropertyUnitInsert;

  const [unit] = await db
    .insert(propertyUnits)
    .values(unitInsert)
    .returning({ unitId: propertyUnits.unitId });

  if (unit === undefined) {
    throw new Error('Drizzle did not return the Day 4 demo unit row.');
  }

  return {
    resourceRef: {
      moduleId: 'property.registry',
      resourceId: 'property.unit',
      resourceKey: unit.unitId,
    },
    unitId: unit.unitId,
  };
};
