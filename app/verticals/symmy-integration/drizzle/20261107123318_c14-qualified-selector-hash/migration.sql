-- Pure parity with the public selector codec. UTF-16 code-unit lengths preserve opaque Unicode keys.
-- The helper reads no data and grants no authority; the caller still scopes current route enrollment.
CREATE FUNCTION symmy_integration.symmy_source_selector_code(
  p_tenant text,p_issuer text,p_namespace text,p_route text,p_kind text,p_record text,p_target text
) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, symmy_integration, pg_temp
AS $$
  SELECT '~c14s1.' || translate(rtrim(encode(sha256(convert_to(string_agg(
    (SELECT coalesce(sum(CASE WHEN ascii(substr(part.value,position,1))>65535 THEN 2 ELSE 1 END),0)
      FROM generate_series(1,char_length(part.value)) AS position)::text || ':' || part.value,
    '' ORDER BY part.ordinality), 'UTF8')), 'base64'),'='),'+/','-_') || '.' || p_target
  FROM unnest(ARRAY[p_tenant,p_issuer,p_namespace,p_route,p_kind,p_record]) WITH ORDINALITY AS part(value,ordinality)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION symmy_integration.symmy_source_selector_code(text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION symmy_integration.symmy_source_selector_code(text,text,text,text,text,text,text) TO ontos_runtime;
