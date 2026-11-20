import { Schema } from 'effect';

const SymmyRouteEnrollmentRefusalCodeSchema = Schema.Literals([
  'invalid_request',
  'stock_route_pending_inventory_setup',
  'route_not_inventoried',
  'owner_intent_enrolled',
  'configuration_field_not_allowed',
  'route_code_invalid',
  'selector_invalid',
  'operation_not_in_route_inventory',
  'required_operation_missing',
  'operation_entity_kind_mismatch',
  'price_source_mismatch',
  'company_scope_required',
  'source_identity_mixed',
  'source_identity_differs_from_counterpart',
  'price_revision_reads_missing',
  'price_revision_company_differs',
  'lifecycle_policy_required',
  'lifecycle_policy_not_configured',
  'operation_not_published',
  'call_not_declared',
  'module_not_active',
  'company_not_active',
  'integration_principal_not_active',
  'integration_principal_not_integration',
  'integration_api_key_binding_missing',
  'integration_binding_missing',
  'executor_binding_missing',
  'executor_binding_not_unique',
  'executor_principals_differ',
  'route_selector_ambiguous',
  'route_id_conflict',
  'route_drift',
  'revision_not_advanced',
  'change_token_not_current',
  'outstanding_work',
  'route_not_enrolled',
]);
export type SymmyRouteEnrollmentRefusalCode = typeof SymmyRouteEnrollmentRefusalCodeSchema.Type;

const SymmyRouteEnrollmentRefusalSchema = Schema.Struct({
  code: SymmyRouteEnrollmentRefusalCodeSchema,
  detail: Schema.String,
});
export type SymmyRouteEnrollmentRefusal = typeof SymmyRouteEnrollmentRefusalSchema.Type;

/** The enrollment was decided against: nothing was written. */
export class SymmyRouteEnrollmentRefused extends Schema.TaggedError<SymmyRouteEnrollmentRefused>()(
  'SymmyRouteEnrollmentRefused',
  { refusals: Schema.NonEmptyArray(SymmyRouteEnrollmentRefusalSchema) },
) {}
