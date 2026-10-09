import { pgSchema } from 'drizzle-orm/pg-core';

export const INVENTORY_SCHEMA_NAME = 'inventory';

/** Sole PostgreSQL schema declaration shared by every Inventory-owned table. */
export const inventorySchema = pgSchema(INVENTORY_SCHEMA_NAME);
