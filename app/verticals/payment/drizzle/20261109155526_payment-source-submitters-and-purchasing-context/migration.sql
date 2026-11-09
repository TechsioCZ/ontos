-- #1152/#1153: a source authority speaks only through the principals bound to it at its current
-- revision; the binding is part of the append-only authority revision history.
-- #1147/#1149: a Payment keeps the trusted Commerce Purchasing Context it was created for, so later
-- entitlement/policy questions are scoped to that exact purchase.
-- #1151/#1152: every accepted SOURCE_CORRECTION records what it did to the Current interpretation.
-- Rows written before these facts existed carry no such evidence and are never fabricated: the checks
-- are NOT VALID, so they bind every new row while historical rows stay as they were recorded.
ALTER TABLE "payment"."payments" ADD COLUMN "purchasing_context" jsonb;--> statement-breakpoint
ALTER TABLE "payment"."source_authority_revisions" ADD COLUMN "submitter_principal_ids" uuid[];--> statement-breakpoint
ALTER TABLE "payment"."payments" ADD CONSTRAINT "payment_payments_purchasing_context_ck" CHECK ("purchasing_context" is not null and jsonb_typeof("purchasing_context") = 'object') NOT VALID;--> statement-breakpoint
ALTER TABLE "payment"."source_authority_revisions" ADD CONSTRAINT "payment_source_authority_revisions_submitters_ck" CHECK ("submitter_principal_ids" is not null and cardinality("submitter_principal_ids") between 1 and 100 and array_ndims("submitter_principal_ids") = 1 and array_position("submitter_principal_ids", null) is null) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment"."observations" DROP CONSTRAINT "payment_observations_correction_effect_ck", ADD CONSTRAINT "payment_observations_correction_effect_ck" CHECK (("correction_effect" is not null) = ("fact_kind" = 'SOURCE_CORRECTION' and "acceptance_outcome" = 'ACCEPTED_OBSERVATION') and ("correction_effect" is null or "correction_effect" in ('RECORD_ONLY', 'REDUCE_ESTABLISHED_COLLECTION', 'REOPEN_TO_CONFLICT'))) NOT VALID;