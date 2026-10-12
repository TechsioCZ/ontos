-- Native Privacy restriction semantics remain unavailable in this foundation.
-- Remove the unused mutation capability while preserving the applied migration history.
DROP FUNCTION "commerce_customer_context"."apply_privacy_measure_profile_restriction"(uuid,uuid,uuid[],text[],timestamptz,uuid,uuid);
