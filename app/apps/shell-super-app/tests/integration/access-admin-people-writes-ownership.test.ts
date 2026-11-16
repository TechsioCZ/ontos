import { it } from 'effect-rstest';
import { accessAdminTemplateLayer, withAccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';
import { CASE_TIMEOUT, ownership } from './access-admin-people-writes.fixture.ts';

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'Lidé people writes through the production Shell API',
  (suite) => {
    suite.effect(
      'only the owner hands ownership on, and the successor then administers the tenant',
      () => withAccessAdminCase(ownership),
      CASE_TIMEOUT,
    );
  },
);
