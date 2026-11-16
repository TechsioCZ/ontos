import { it } from 'effect-rstest';
import { accessAdminTemplateLayer, withAccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';
import { CASE_TIMEOUT, admission, coreRefusals } from './access-admin-people-writes.fixture.ts';

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'Lidé people writes through the production Shell API',
  (suite) => {
    suite.effect(
      'the owner admits a directory member into one company, and only then can assign there',
      () => withAccessAdminCase(admission),
      CASE_TIMEOUT,
    );

    suite.effect(
      'Core refuses an admission that would revive lapsed authority, a delegate who may not admit or end, and a company administrator ending a co-administrator',
      () => withAccessAdminCase(coreRefusals),
      CASE_TIMEOUT,
    );
  },
);
