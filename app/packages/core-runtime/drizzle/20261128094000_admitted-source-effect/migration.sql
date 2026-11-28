-- The stored commitment binds the native payload (including its allocated order and effect id) and receiver.
CREATE FUNCTION trust.source_effect_commitment(p_action text, p_payload jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(p_action,p_payload)::text,'UTF8')),'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION trust.hold_admitted_source_effect(p_tenant uuid, p_company uuid, p_admission uuid, p_source_action text, p_receiver text, p_payload jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_admission IS NULL OR p_company IS NULL OR p_company IS DISTINCT FROM nullif(current_setting('ontos.legal_entity_id',true),'')::uuid THEN RETURN false; END IF;
 -- Core verifies the installed tenant, original admission and still-live enrollment under SHARE until commit.
 IF NOT trust.lock_source_execution_fence(p_tenant,p_admission) THEN RETURN false; END IF;
 RETURN EXISTS (SELECT FROM core.action_invocations i WHERE i.tenant_id=p_tenant AND i.legal_entity_id=p_company AND i.action_invocation_id=p_admission
   AND i.action_key=p_source_action AND i.status='succeeded' AND i.committed_reply_json->>'kind'='result'
   AND i.committed_reply_json->'encoded'->'sourceEffectCommitments' @> to_jsonb(array[trust.source_effect_commitment(p_receiver,p_payload)]));
END; $$;
--> statement-breakpoint
-- Only callable from the migration-owner routines that allocate or apply an effect. No request role is a caller.
REVOKE ALL ON FUNCTION trust.hold_admitted_source_effect(uuid,uuid,uuid,text,text,jsonb), trust.source_effect_commitment(text,jsonb) FROM PUBLIC, ontos_runtime;
