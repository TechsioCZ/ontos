/**
 * The CHECK constraints of `symmy_integration.route_enrollment_records`, each as PostgreSQL prints it with
 * `pg_get_constraintdef`. PostgreSQL stores a CHECK as its analysed expression, not its source text, and prints it
 * without pretty-printing: every comparison, null test, `= ANY` and AND or OR group in parentheses of its own, an IN list
 * as `= ANY (ARRAY[...])`, a literal compared with a text column as `'...'::text`, and a BETWEEN as its `>=` and `<=`
 * comparisons in an AND group of their own. The grouping is part of the predicate, so it is compared as printed.
 */
export const ROUTE_ENROLLMENT_RECORD_CHECKS = [
  [
    'symmy_route_enrollment_records_change_ck',
    "CHECK (((change = ANY (ARRAY['enroll'::text, 'replace'::text, 'deactivate'::text]))" +
      " AND ((change = 'enroll'::text) = (previous_revision IS NULL))" +
      " AND ((change = 'enroll'::text) = (previous_change_token IS NULL))" +
      ' AND ((previous_change_token IS NULL) OR (change_token <> previous_change_token))' +
      ' AND (change_token >= 1)' +
      " AND ((change <> 'deactivate'::text) OR (previous_revision = route_revision))))",
  ],
  [
    'symmy_route_enrollment_records_text_ck',
    'CHECK ((((char_length(stated_operator_ref) >= 1) AND (char_length(stated_operator_ref) <= 200))' +
      ' AND ((char_length(reason) >= 1) AND (char_length(reason) <= 500))' +
      ' AND ((char_length(route_revision) >= 1) AND (char_length(route_revision) <= 80))' +
      ' AND ((previous_revision IS NULL)' +
      ' OR ((char_length(previous_revision) >= 1) AND (char_length(previous_revision) <= 80)))))',
  ],
] as const;

/**
 * A printed constraint definition with only what the printing leaves free made uniform: runs of whitespace.
 * Parentheses, operators, identifiers, literals and casts stay as printed; none of these column names needs quoting.
 */
export const normalizeConstraintDefinition = (definition: string): string => definition.replaceAll(/\s+/gu, ' ').trim();
