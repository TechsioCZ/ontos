DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM core.tenant_module_states AS legacy
    INNER JOIN core.tenant_module_states AS contacts
      ON contacts.tenant_id = legacy.tenant_id
      AND contacts.module_key = 'contacts.core'
    WHERE legacy.module_key = 'crm.core'
  ) THEN
    RAISE EXCEPTION 'Contacts identity migration would collide in tenant_module_states';
  END IF;
END $$;
--> statement-breakpoint
UPDATE core.tenant_module_states SET module_key = 'contacts.core' WHERE module_key = 'crm.core';
--> statement-breakpoint
UPDATE core.tenant_module_state_changes SET module_key = 'contacts.core' WHERE module_key = 'crm.core';
--> statement-breakpoint
UPDATE core.action_invocations SET
  action_key = CASE WHEN action_key = 'crm.core' THEN 'contacts.core' ELSE 'contacts.core' || substring(action_key FROM 9) END
WHERE action_key = 'crm.core' OR action_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.action_invocations SET
  target_module_key = CASE WHEN target_module_key = 'crm.core' THEN 'contacts.core' ELSE 'contacts.core' || substring(target_module_key FROM 9) END
WHERE target_module_key = 'crm.core' OR target_module_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.action_invocations SET
  target_resource_type = 'contacts.core' || substring(target_resource_type FROM 9)
WHERE target_resource_type = 'crm.core' OR target_resource_type LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.audit_events SET
  target_module_key = CASE WHEN target_module_key = 'crm.core' THEN 'contacts.core' ELSE 'contacts.core' || substring(target_module_key FROM 9) END
WHERE target_module_key = 'crm.core' OR target_module_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.audit_events SET
  target_resource_type = 'contacts.core' || substring(target_resource_type FROM 9)
WHERE target_resource_type = 'crm.core' OR target_resource_type LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.data_access_events SET
  serving_module_key = CASE WHEN serving_module_key = 'crm.core' THEN 'contacts.core' ELSE 'contacts.core' || substring(serving_module_key FROM 9) END
WHERE serving_module_key = 'crm.core' OR serving_module_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.data_access_events SET
  target_module_key = CASE WHEN target_module_key = 'crm.core' THEN 'contacts.core' ELSE 'contacts.core' || substring(target_module_key FROM 9) END
WHERE target_module_key = 'crm.core' OR target_module_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.data_access_events SET
  target_resource_type = 'contacts.core' || substring(target_resource_type FROM 9)
WHERE target_resource_type = 'crm.core' OR target_resource_type LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.data_access_events SET
  evidence_policy_key = 'contacts.core' || substring(evidence_policy_key FROM 9)
WHERE evidence_policy_key = 'crm.core' OR evidence_policy_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.domain_events SET
  producer_module_key = CASE WHEN producer_module_key = 'crm.core' THEN 'contacts.core' ELSE 'contacts.core' || substring(producer_module_key FROM 9) END
WHERE producer_module_key = 'crm.core' OR producer_module_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.domain_events SET
  subject_module_key = CASE WHEN subject_module_key = 'crm.core' THEN 'contacts.core' ELSE 'contacts.core' || substring(subject_module_key FROM 9) END
WHERE subject_module_key = 'crm.core' OR subject_module_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.domain_events SET
  subject_resource_type = 'contacts.core' || substring(subject_resource_type FROM 9)
WHERE subject_resource_type = 'crm.core' OR subject_resource_type LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.outbox_messages SET
  producer_module_key = CASE WHEN producer_module_key = 'crm.core' THEN 'contacts.core' ELSE 'contacts.core' || substring(producer_module_key FROM 9) END
WHERE producer_module_key = 'crm.core' OR producer_module_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.outbox_deliveries SET
  consumer_module_key = CASE WHEN consumer_module_key = 'crm.core' THEN 'contacts.core' ELSE 'contacts.core' || substring(consumer_module_key FROM 9) END
WHERE consumer_module_key = 'crm.core' OR consumer_module_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.media_links SET
  target_module_key = CASE WHEN target_module_key = 'crm.core' THEN 'contacts.core' ELSE 'contacts.core' || substring(target_module_key FROM 9) END
WHERE target_module_key = 'crm.core' OR target_module_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.media_links SET
  target_resource_type = 'contacts.core' || substring(target_resource_type FROM 9)
WHERE target_resource_type = 'crm.core' OR target_resource_type LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.evidence_references SET
  subject_module_key = CASE WHEN subject_module_key = 'crm.core' THEN 'contacts.core' ELSE 'contacts.core' || substring(subject_module_key FROM 9) END
WHERE subject_module_key = 'crm.core' OR subject_module_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.evidence_references SET
  subject_resource_type = 'contacts.core' || substring(subject_resource_type FROM 9)
WHERE subject_resource_type = 'crm.core' OR subject_resource_type LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.evidence_references SET
  evidence_policy_key = 'contacts.core' || substring(evidence_policy_key FROM 9)
WHERE evidence_policy_key = 'crm.core' OR evidence_policy_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.evidence_references SET
  retention_policy_key = 'contacts.core' || substring(retention_policy_key FROM 9)
WHERE retention_policy_key = 'crm.core' OR retention_policy_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.search_index_entries SET
  source_module_key = CASE WHEN source_module_key = 'crm.core' THEN 'contacts.core' ELSE 'contacts.core' || substring(source_module_key FROM 9) END
WHERE source_module_key = 'crm.core' OR source_module_key LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.search_index_entries SET
  source_resource_type = 'contacts.core' || substring(source_resource_type FROM 9)
WHERE source_resource_type = 'crm.core' OR source_resource_type LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.worker_checkpoints SET
  consumer_name = 'contacts.core' || substring(consumer_name FROM 9)
WHERE consumer_name = 'crm.core' OR consumer_name LIKE 'crm.core.%';
--> statement-breakpoint
UPDATE core.worker_checkpoints SET
  stream_key = 'contacts.core' || substring(stream_key FROM 9)
WHERE stream_key = 'crm.core' OR stream_key LIKE 'crm.core.%';
