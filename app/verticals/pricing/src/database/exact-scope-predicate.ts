/** A catalog expression is SQL, so whitespace and case inside its string literals remain significant. */
export const exactTenantCompanyScopePredicateSql = (expression: string): string => `(
  select coalesce(string_agg(
    case when left(token.parts[1], 1) = '''' then token.parts[1]
      else regexp_replace(lower(token.parts[1]), '[()[:space:]]', '', 'g') end,
    '' order by token.ordinal
  ), '') = $$tenant_id=nullifcurrent_setting'ontos.tenant_id'::text,true,''::text::uuidandlegal_entity_id=nullifcurrent_setting'ontos.legal_entity_id'::text,true,''::text::uuid$$
  from regexp_matches(${expression}, $$'(?:[^']|'')*'|[^']+$$, 'g')
    with ordinality as token(parts, ordinal)
)`;
