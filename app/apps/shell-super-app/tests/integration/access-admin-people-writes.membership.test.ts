import { it } from 'effect-rstest';
import { accessAdminTemplateLayer, withAccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';
import { CASE_TIMEOUT, endMembership, roleAssignment } from './access-admin-people-writes.fixture.ts';

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'Lidé people writes through the production Shell API',
  (suite) => {
    suite.effect(
      'ending a company membership closes what it carried at once, and re-admission starts clean',
      () => withAccessAdminCase(endMembership),
      CASE_TIMEOUT,
    );

    suite.effect(
      'role assignment needs a member, a reachable role and the current revisions, and revocation ends it',
      () => withAccessAdminCase(roleAssignment),
      CASE_TIMEOUT,
    );
  },
);
