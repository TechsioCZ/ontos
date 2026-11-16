ALTER FUNCTION commerce_customer_context.customer_group_membership_document(uuid, uuid, uuid) SET row_security = on;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.archive_customer_group(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) SET row_security = on;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.reactivate_customer_group(uuid, uuid, uuid, integer, timestamptz, text, timestamptz, uuid, uuid) SET row_security = on;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.assign_customer_group_membership(uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, text, timestamptz, uuid, uuid) SET row_security = on;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.remove_customer_group_membership(uuid, uuid, uuid, uuid, uuid, text, timestamptz, text, timestamptz, uuid, uuid) SET row_security = on;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.apply_customer_group_membership_source(uuid, uuid, uuid, uuid, timestamptz, jsonb) SET row_security = on;
--> statement-breakpoint
ALTER FUNCTION commerce_customer_context.read_customer_group_membership_source_receipt(uuid, uuid, uuid, jsonb) SET row_security = on;
