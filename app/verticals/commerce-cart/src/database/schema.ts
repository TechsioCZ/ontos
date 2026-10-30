import { tenantLegalEntityRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  check,
  foreignKey,
  integer,
  index,
  jsonb,
  pgPolicy,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const COMMERCE_CART_SCHEMA_NAME = 'commerce_cart';
export const commerceCartSchema = pgSchema(COMMERCE_CART_SCHEMA_NAME);

/** Technical ingress replay evidence, consumed before Tenant/SLE can be trusted. */
export const gatewayAssertionRedemptions = commerceCartSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('cart_gateway_assertion_redemptions_identity_uk').on(table.issuer, table.audience, table.jti),
    index('cart_gateway_assertion_redemptions_expiry_idx').on(table.expiresAt),
    check('cart_gateway_assertion_redemptions_audience_ck', sql`${table.audience} = 'commerce-cart'`),
  ],
);

// The population is intentionally readable across SLEs within one Tenant. Writes remain
// bound to the source Cart SLE. No privilege elevation or RLS-bypassing view is involved.
const populationPolicies = (prefix: string, tenant: AnyPgColumn, legalEntity: AnyPgColumn) => {
  const tenantMatches = sql`${tenant} = nullif(current_setting('ontos.tenant_id', true), '')::uuid`;
  const sourceMatches = sql`${tenantMatches} and ${legalEntity} = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;
  return [
    pgPolicy(`${prefix}_select`, { for: 'select', to: 'ontos_runtime', using: tenantMatches }),
    pgPolicy(`${prefix}_insert`, { for: 'insert', to: 'ontos_runtime', withCheck: sourceMatches }),
    pgPolicy(`${prefix}_update`, {
      for: 'update',
      to: 'ontos_runtime',
      using: sourceMatches,
      withCheck: sourceMatches,
    }),
    pgPolicy(`${prefix}_delete`, { for: 'delete', to: 'ontos_runtime', using: sourceMatches }),
  ];
};

export const populationRoots = commerceCartSchema.table.withRLS(
  'population_roots',
  {
    generation: bigint('generation', { mode: 'bigint' }).notNull(),
    historyId: uuid('history_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId], name: 'cart_population_roots_pk' }),
    check('cart_population_roots_generation_ck', sql`${table.generation} >= 0`),
    pgPolicy('cart_population_roots_select', {
      for: 'select',
      to: 'ontos_runtime',
      using: sql`${table.tenantId} = nullif(current_setting('ontos.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('cart_population_roots_insert', {
      for: 'insert',
      to: 'ontos_runtime',
      withCheck: sql`${table.tenantId} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and nullif(current_setting('ontos.legal_entity_id', true), '') is null and ${table.generation} = 0`,
    }),
    pgPolicy('cart_population_roots_update', {
      for: 'update',
      to: 'ontos_runtime',
      using: sql`${table.tenantId} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and nullif(current_setting('ontos.legal_entity_id', true), '') is not null`,
      withCheck: sql`${table.tenantId} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and nullif(current_setting('ontos.legal_entity_id', true), '') is not null`,
    }),
  ],
);

export const carts = commerceCartSchema.table.withRLS(
  'carts',
  {
    cartId: uuid('cart_id').notNull(),
    creatorPrincipalId: uuid('creator_principal_id').notNull(),
    currentRevisionId: uuid('current_revision_id').notNull(),
    intendedContext: jsonb('intended_context').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.cartId], name: 'carts_pk' }),
    unique('carts_sle_uk').on(table.tenantId, table.legalEntityId, table.cartId),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [populationRoots.tenantId],
      name: 'carts_population_root_fk',
    }),
    check('carts_context_size_ck', sql`octet_length(${table.intendedContext}::text) between 2 and 16384`),
    ...tenantLegalEntityRlsPolicies('carts_scope', table.tenantId, table.legalEntityId),
  ],
);

export const cartRevisions = commerceCartSchema.table.withRLS(
  'cart_revisions',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actorPrincipalId: uuid('actor_principal_id').notNull(),
    cartId: uuid('cart_id').notNull(),
    encodedCart: jsonb('encoded_cart').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    populationGeneration: bigint('population_generation', { mode: 'bigint' }).notNull(),
    previousRevisionId: uuid('previous_revision_id'),
    revisionId: uuid('revision_id').notNull(),
    revisionNumber: bigint('revision_number', { mode: 'bigint' }).notNull(),
    status: text('status').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.cartId, table.revisionId], name: 'cart_revisions_pk' }),
    unique('cart_revisions_sequence_uk').on(table.tenantId, table.cartId, table.revisionNumber),
    unique('cart_revisions_invocation_uk').on(table.tenantId, table.actionInvocationId),
    unique('cart_revisions_sle_uk').on(table.tenantId, table.legalEntityId, table.cartId, table.revisionId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.cartId],
      foreignColumns: [carts.tenantId, carts.legalEntityId, carts.cartId],
      name: 'cart_revisions_cart_fk',
    }),
    check(
      'cart_revisions_snapshot_size_ck',
      sql`octet_length(${table.encodedCart}::text) between 2 and 262144 and ${table.populationGeneration} > 0`,
    ),
    check(
      'cart_revisions_number_ck',
      sql`${table.revisionNumber} between 1 and 2147483647 and ((${table.revisionNumber} = 1 and ${table.previousRevisionId} is null) or (${table.revisionNumber} > 1 and ${table.previousRevisionId} is not null))`,
    ),
    check('cart_revisions_status_ck', sql`${table.status} in ('OPEN', 'CLOSED')`),
    ...tenantLegalEntityRlsPolicies('cart_revisions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const cartRevisionSelections = commerceCartSchema.table.withRLS(
  'cart_revision_selections',
  {
    cartId: uuid('cart_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    originRevisionId: uuid('origin_revision_id').notNull(),
    position: integer('position').notNull(),
    requestedQuantity: text('requested_quantity').notNull(),
    requestedUnit: jsonb('requested_unit').notNull(),
    revisionId: uuid('revision_id').notNull(),
    selection: jsonb('selection').notNull(),
    selectionId: uuid('selection_id').notNull(),
    sourceActionInvocationId: uuid('source_action_invocation_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.cartId, table.revisionId, table.selectionId],
      name: 'cart_revision_selections_pk',
    }),
    unique('cart_revision_selections_position_uk').on(table.tenantId, table.cartId, table.revisionId, table.position),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.cartId, table.revisionId],
      foreignColumns: [
        cartRevisions.tenantId,
        cartRevisions.legalEntityId,
        cartRevisions.cartId,
        cartRevisions.revisionId,
      ],
      name: 'cart_revision_selections_revision_fk',
    }),
    check('cart_revision_selections_position_ck', sql`${table.position} >= 0`),
    check(
      'cart_revision_selections_selection_size_ck',
      sql`octet_length(${table.selection}::text) between 2 and 65536`,
    ),
    check(
      'cart_revision_selections_quantity_ck',
      sql`${table.requestedQuantity} ~ '^[0-9]+([.][0-9]+)?$' and length(${table.requestedQuantity}) <= 100 and ${table.requestedQuantity}::numeric > 0`,
    ),
    check('cart_revision_selections_unit_size_ck', sql`octet_length(${table.requestedUnit}::text) between 2 and 4096`),
    ...tenantLegalEntityRlsPolicies('cart_revision_selections_scope', table.tenantId, table.legalEntityId),
  ],
);

export const populationCartVersions = commerceCartSchema.table.withRLS(
  'population_cart_versions',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actorPrincipalId: uuid('actor_principal_id').notNull(),
    cartId: uuid('cart_id').notNull(),
    creatorPrincipalId: uuid('creator_principal_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    revisionNumber: bigint('revision_number', { mode: 'bigint' }).notNull(),
    status: text('status').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.cartId, table.revisionId], name: 'cart_population_versions_pk' }),
    unique('cart_population_versions_sle_uk').on(table.tenantId, table.legalEntityId, table.cartId, table.revisionId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.cartId, table.revisionId],
      foreignColumns: [
        cartRevisions.tenantId,
        cartRevisions.legalEntityId,
        cartRevisions.cartId,
        cartRevisions.revisionId,
      ],
      name: 'cart_population_versions_source_fk',
    }),
    check('cart_population_versions_status_ck', sql`${table.status} in ('OPEN', 'CLOSED')`),
    ...populationPolicies('cart_population_versions_scope', table.tenantId, table.legalEntityId),
  ],
);

export const populationSelectionRefs = commerceCartSchema.table.withRLS(
  'population_selection_refs',
  {
    cartId: uuid('cart_id').notNull(),
    createdByPrincipalId: uuid('created_by_principal_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    originRevisionId: uuid('origin_revision_id').notNull(),
    position: integer('position').notNull(),
    revisionId: uuid('revision_id').notNull(),
    selection: jsonb('selection').notNull(),
    selectionId: uuid('selection_id').notNull(),
    sourceActionInvocationId: uuid('source_action_invocation_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.cartId, table.revisionId, table.selectionId],
      name: 'cart_population_selections_pk',
    }),
    unique('cart_population_selections_position_uk').on(table.tenantId, table.cartId, table.revisionId, table.position),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.cartId, table.revisionId],
      foreignColumns: [
        populationCartVersions.tenantId,
        populationCartVersions.legalEntityId,
        populationCartVersions.cartId,
        populationCartVersions.revisionId,
      ],
      name: 'cart_population_selections_version_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.cartId, table.revisionId, table.selectionId],
      foreignColumns: [
        cartRevisionSelections.tenantId,
        cartRevisionSelections.cartId,
        cartRevisionSelections.revisionId,
        cartRevisionSelections.selectionId,
      ],
      name: 'cart_population_selections_source_fk',
    }),
    check('cart_population_selections_position_ck', sql`${table.position} >= 0`),
    check('cart_population_selections_size_ck', sql`octet_length(${table.selection}::text) between 2 and 65536`),
    ...populationPolicies('cart_population_selections_scope', table.tenantId, table.legalEntityId),
  ],
);

export const populationCartHeads = commerceCartSchema.table.withRLS(
  'population_cart_heads',
  {
    cartId: uuid('cart_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.cartId], name: 'cart_population_heads_pk' }),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.cartId, table.revisionId],
      foreignColumns: [
        populationCartVersions.tenantId,
        populationCartVersions.legalEntityId,
        populationCartVersions.cartId,
        populationCartVersions.revisionId,
      ],
      name: 'cart_population_heads_version_fk',
    }),
    ...populationPolicies('cart_population_heads_scope', table.tenantId, table.legalEntityId),
  ],
);

export const populationGenerationHistory = commerceCartSchema.table.withRLS(
  'population_generation_history',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    actorPrincipalId: uuid('actor_principal_id').notNull(),
    cartId: uuid('cart_id'),
    generation: bigint('generation', { mode: 'bigint' }).notNull(),
    historyId: uuid('history_id').notNull(),
    legalEntityId: uuid('legal_entity_id'),
    previousHistoryId: uuid('previous_history_id'),
    revisionId: uuid('revision_id'),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.generation], name: 'cart_population_history_pk' }),
    unique('cart_population_history_id_uk').on(table.tenantId, table.historyId),
    unique('cart_population_history_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [populationRoots.tenantId],
      name: 'cart_population_history_root_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.cartId, table.revisionId],
      foreignColumns: [
        populationCartVersions.tenantId,
        populationCartVersions.legalEntityId,
        populationCartVersions.cartId,
        populationCartVersions.revisionId,
      ],
      name: 'cart_population_history_version_fk',
    }),
    check(
      'cart_population_history_shape_ck',
      sql`(${table.generation} = 0 and ${table.previousHistoryId} is null and ${table.legalEntityId} is null and ${table.cartId} is null and ${table.revisionId} is null) or (${table.generation} > 0 and ${table.previousHistoryId} is not null and ${table.legalEntityId} is not null and ${table.cartId} is not null and ${table.revisionId} is not null)`,
    ),
    pgPolicy('cart_population_history_select', {
      for: 'select',
      to: 'ontos_runtime',
      using: sql`${table.tenantId} = nullif(current_setting('ontos.tenant_id', true), '')::uuid`,
    }),
    pgPolicy('cart_population_history_insert', {
      for: 'insert',
      to: 'ontos_runtime',
      withCheck: sql`${table.tenantId} = nullif(current_setting('ontos.tenant_id', true), '')::uuid and ((${table.generation} = 0 and nullif(current_setting('ontos.legal_entity_id', true), '') is null) or (${table.generation} > 0 and ${table.legalEntityId} = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid))`,
    }),
  ],
);

/** One immutable, owner-finalized purchase candidate; opening preparation remains unverified. */
export const finalCartCandidates = commerceCartSchema.table.withRLS(
  'final_cart_candidates',
  {
    actionInvocationId: uuid('action_invocation_id').notNull(),
    buyerPrincipalId: uuid('buyer_principal_id').notNull(),
    candidateHash: text('candidate_hash').notNull(),
    candidateId: uuid('candidate_id').notNull(),
    cartId: uuid('cart_id').notNull(),
    encodedCandidate: jsonb('encoded_candidate').notNull(),
    finalRevisionId: uuid('final_revision_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    materialJson: text('material_json').notNull(),
    sourceRevisionId: uuid('source_revision_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.candidateId], name: 'final_cart_candidates_pk' }),
    unique('final_cart_candidates_cart_uk').on(table.tenantId, table.cartId),
    unique('final_cart_candidates_invocation_uk').on(table.tenantId, table.actionInvocationId),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.cartId, table.sourceRevisionId],
      foreignColumns: [
        cartRevisions.tenantId,
        cartRevisions.legalEntityId,
        cartRevisions.cartId,
        cartRevisions.revisionId,
      ],
      name: 'final_cart_candidates_source_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId, table.cartId, table.finalRevisionId],
      foreignColumns: [
        cartRevisions.tenantId,
        cartRevisions.legalEntityId,
        cartRevisions.cartId,
        cartRevisions.revisionId,
      ],
      name: 'final_cart_candidates_closed_fk',
    }),
    check(
      'final_cart_candidates_digest_ck',
      sql`${table.candidateHash} ~ '^[a-f0-9]{64}$' and ${table.candidateHash} = encode(sha256(convert_to(${table.materialJson}, 'UTF8')), 'hex')`,
    ),
    check(
      'final_cart_candidates_material_ck',
      sql`octet_length(${table.materialJson}) between 2 and 2097152 and ${table.materialJson}::jsonb = ${table.encodedCandidate} - 'candidateHash' and (${table.encodedCandidate}->>'candidateHash') is not distinct from ${table.candidateHash}`,
    ),
    ...tenantLegalEntityRlsPolicies('final_cart_candidates_scope', table.tenantId, table.legalEntityId),
  ],
);

export const COMMERCE_CART_BUSINESS_TABLES = [
  finalCartCandidates,
  carts,
  cartRevisions,
  cartRevisionSelections,
  populationRoots,
  populationCartVersions,
  populationSelectionRefs,
  populationCartHeads,
  populationGenerationHistory,
] as const;
export const COMMERCE_CART_TABLES = [...COMMERCE_CART_BUSINESS_TABLES, gatewayAssertionRedemptions] as const;
