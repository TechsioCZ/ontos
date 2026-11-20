import { describe, expect, it } from 'effect-rstest';

import {
  ROUTE_ENROLLMENT_RECORD_CHECKS,
  normalizeConstraintDefinition,
} from '../../scripts/route-enrollment-record-checks.mts';

const [[, changeCheck], [, textCheck]] = ROUTE_ENROLLMENT_RECORD_CHECKS;

describe('route enrollment record check definitions', () => {
  it('match themselves as PostgreSQL prints them', () => {
    expect(normalizeConstraintDefinition(changeCheck)).toBe(normalizeConstraintDefinition(changeCheck));
    expect(normalizeConstraintDefinition(textCheck)).toBe(normalizeConstraintDefinition(textCheck));
  });

  it('leave only whitespace and identifier quotes free', () => {
    const quoted = changeCheck.replaceAll('previous_revision', '"previous_revision"').replaceAll(' AND ', '\n    AND ');
    expect(normalizeConstraintDefinition(quoted)).toBe(normalizeConstraintDefinition(changeCheck));
  });

  it('refuse the change check once its final OR loses its grouping', () => {
    const ungrouped = changeCheck.replace(
      " AND ((change <> 'deactivate'::text) OR (previous_revision = route_revision))))",
      " AND (change <> 'deactivate'::text) OR (previous_revision = route_revision)))",
    );
    expect(ungrouped).not.toBe(changeCheck);
    expect(normalizeConstraintDefinition(ungrouped)).not.toBe(normalizeConstraintDefinition(changeCheck));
  });
});
