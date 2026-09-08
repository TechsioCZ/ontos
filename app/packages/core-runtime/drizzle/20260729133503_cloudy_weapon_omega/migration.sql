CREATE SEQUENCE "core"."domain_event_tenant_sequence_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "core"."domain_events" ALTER COLUMN "tenant_sequence_no" SET DEFAULT nextval('core.domain_event_tenant_sequence_no_seq'::regclass);
