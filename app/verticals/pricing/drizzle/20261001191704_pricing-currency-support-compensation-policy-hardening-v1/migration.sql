-- Keep the immutable compensation receipt deny policies effective for every role used by the
-- SECURITY DEFINER compensation routine. The writer still has no UPDATE or DELETE table grant;
-- these policies preserve the denial if grants are audited or tightened independently later.
ALTER POLICY pricing_currency_support_recovery_compensation_tenant_update
  ON pricing.currency_support_recovery_compensation_receipts
  TO ontos_runtime, pricing_management_routine_writer;
ALTER POLICY pricing_currency_support_recovery_compensation_tenant_delete
  ON pricing.currency_support_recovery_compensation_receipts
  TO ontos_runtime, pricing_management_routine_writer;
