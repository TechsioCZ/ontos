import { jsonb, numeric, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const coreSchema = pgSchema('core');

export const coreTenants = coreSchema.table('tenants', {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  defaultLocale: text('default_locale').notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  status: text('status').notNull(),
  tenantId: uuid('tenant_id').primaryKey(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const coreLegalEntities = coreSchema.table('legal_entities', {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  legalEntityId: uuid('legal_entity_id').primaryKey(),
  legalName: text('legal_name').notNull(),
  registrationCountry: text('registration_country').notNull(),
  registrationNumber: text('registration_number').notNull(),
  status: text('status').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  vatId: text('vat_id'),
});

export const corePrincipals = coreSchema.table('principals', {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  displayName: text('display_name').notNull(),
  kind: text('kind').notNull(),
  principalId: uuid('principal_id').primaryKey(),
  status: text('status').notNull(),
  tenantId: uuid('tenant_id').notNull(),
});

export const corePrincipalAuthBindings = coreSchema.table('principal_auth_bindings', {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  principalAuthBindingId: uuid('principal_auth_binding_id').primaryKey(),
  principalId: uuid('principal_id').notNull(),
  provider: text('provider').notNull(),
  providerSubjectId: text('provider_subject_id').notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  status: text('status').notNull(),
  subjectType: text('subject_type').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const coreTenantModuleStates = coreSchema.table('tenant_module_states', {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  lastChangeId: uuid('last_change_id'),
  moduleKey: text('module_key').notNull(),
  state: text('state').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  tenantModuleStateId: uuid('tenant_module_state_id').primaryKey(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

const propertySchema = pgSchema('property');

export const propertyProperties = propertySchema.table('properties', {
  addressJson: jsonb('address_json').notNull(),
  code: text('code').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  legalEntityId: uuid('legal_entity_id').notNull(),
  lifecycleState: text('lifecycle_state').notNull(),
  name: text('name').notNull(),
  propertyId: uuid('property_id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const propertyBuildings = propertySchema.table('buildings', {
  buildingId: uuid('building_id').defaultRandom().primaryKey(),
  code: text('code').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  lifecycleState: text('lifecycle_state').notNull(),
  name: text('name').notNull(),
  propertyId: uuid('property_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const propertyUnits = propertySchema.table('units', {
  areaM2: numeric('area_m2').notNull(),
  buildingId: uuid('building_id').notNull(),
  code: text('code').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  floorLabel: text('floor_label').notNull(),
  lifecycleState: text('lifecycle_state').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  unitId: uuid('unit_id').defaultRandom().primaryKey(),
  unitType: text('unit_type').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export type PropertyUnitInsert = typeof propertyUnits.$inferInsert;
export type PropertyUnitRow = typeof propertyUnits.$inferSelect;
