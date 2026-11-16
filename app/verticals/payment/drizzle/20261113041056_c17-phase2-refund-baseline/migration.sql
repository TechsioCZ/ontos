ALTER TABLE "payment"."psp_provider_dispatches" ADD COLUMN "provider_refund_baseline" jsonb;--> statement-breakpoint
ALTER TABLE "payment"."psp_provider_dispatches" ADD CONSTRAINT "payment_psp_dispatches_refund_baseline_ck" CHECK ("provider_refund_baseline" is null or ("operation_kind" = 'REFUND' and "provider_family" = 'GOPAY' and "prepared_at" is not null
        and jsonb_typeof("provider_refund_baseline") = 'array' and jsonb_array_length("provider_refund_baseline") <= 1000
        and not jsonb_path_exists("provider_refund_baseline", '$[*] ? (@.type() != "string")')));