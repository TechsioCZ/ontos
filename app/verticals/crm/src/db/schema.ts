import { pgSchema } from 'drizzle-orm/pg-core';

export const CRM_SCHEMA_NAME = 'crm' as const;
export const CRM_TABLE_INVENTORY = [] as const;

export const crmSchema = pgSchema(CRM_SCHEMA_NAME);

export const crmDatabaseSchema = {};
