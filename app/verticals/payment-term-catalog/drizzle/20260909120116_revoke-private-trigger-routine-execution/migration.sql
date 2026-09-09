REVOKE ALL ON FUNCTION "payment_term_catalog"."protect_payment_term_identity"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."reject_ledger_mutation"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "payment_term_catalog"."protect_payment_term_identity"() FROM "ontos_runtime";
REVOKE ALL ON FUNCTION "payment_term_catalog"."reject_ledger_mutation"() FROM "ontos_runtime";
