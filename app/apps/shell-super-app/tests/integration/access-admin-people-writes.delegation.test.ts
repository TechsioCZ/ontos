import { it } from 'effect-rstest';
import { accessAdminTemplateLayer, withAccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';
import { CASE_TIMEOUT, delegation } from './access-admin-people-writes.fixture.ts';

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'Lidé people writes through the production Shell API',
  (suite) => {
    suite.effect(
      'a delegation is bounded by its grantor, works inside its envelope until revoked, and blocks ending its grantor',
      () => withAccessAdminCase(delegation),
      CASE_TIMEOUT,
    );
  },
);
