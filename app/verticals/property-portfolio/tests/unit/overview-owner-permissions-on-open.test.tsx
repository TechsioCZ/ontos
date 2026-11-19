// @rstest-environment happy-dom
import { text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { RecordsApi as AgreementsApi, RecordsForbiddenProblemSchema } from '@app/legal-agreements/contracts/records';
import { RecordsApi as OccupancyApi } from '@app/property-leasing/contracts/records';
import { RecordsApi as FinanceApi } from '@app/finance-billing/contracts/records';
import { RecordsApi as WorkApi } from '@app/work-tasks/contracts/records';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { RecordsApi } from '../../shared/apis/records.ts';
import { OverviewPage, preloadPage } from '../../src/routes/[lang]/nemovitosti/prehled/page.tsx';
import { mountInRoute } from '../support/module-ui.ts';

const forbidden = RecordsForbiddenProblemSchema.make({
  detail: 'Owner refused this read',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:forbidden',
});
const Agreements = AgreementsApi.prefix('/legal-agreements-api');
const Occupancy = OccupancyApi.prefix('/property-leasing-api');
const Finance = FinanceApi.prefix('/finance-billing-api');
const Work = WorkApi.prefix('/work-tasks-api');
const Property = RecordsApi.prefix('/property-portfolio-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'finance-billing': '/finance-billing-api',
    'legal-agreements': '/legal-agreements-api',
    'property-leasing': '/property-leasing-api',
    'property-portfolio': '/property-portfolio-api',
    'work-tasks': '/work-tasks-api',
  }).application,
  serveApi(
    Agreements,
    HttpApiBuilder.group(Agreements, 'records', (g) => g.handle('execute', () => Effect.fail(forbidden))),
  ),
  serveApi(
    Occupancy,
    HttpApiBuilder.group(Occupancy, 'records', (g) => g.handle('execute', () => Effect.fail(forbidden))),
  ),
  serveApi(
    Finance,
    HttpApiBuilder.group(Finance, 'records', (g) => g.handle('execute', () => Effect.fail(forbidden))),
  ),
  serveApi(
    Work,
    HttpApiBuilder.group(Work, 'records', (g) => g.handle('execute', () => Effect.fail(forbidden))),
  ),
  serveApi(
    Property,
    HttpApiBuilder.group(Property, 'records', (g) => g.handle('execute', () => Effect.fail(forbidden))),
  ),
);
const props = {
  context: { legalEntityId: 'overview-permissions', principalId: 'manager', tenantId: 'tenant' },
  routeParams: {},
  search: '',
};
afterEach(unmountAll);

it.layer(network, { excludeTestServices: true })('overview owner permissions', (suite) => {
  suite.effect('opening the overview reports each owner denial instead of inventing empty portfolio data', () =>
    Effect.gen(function* ownerPermissions() {
      yield* pinTestDocument;
      yield* Effect.promise(() => preloadPage(props));
      yield* mountInRoute(<OverviewPage {...props} />, { path: 'nemovitosti/prehled', url: '/cs/nemovitosti/prehled' });
      yield* waitUntil(() => text().includes('Smlouvy: bez oprávnění'));
      for (const owner of ['Smlouvy', 'Finance', 'Nájmy a pobyty', 'Nemovitosti', 'Úkoly']) {
        expect(text()).toContain(`${owner}: bez oprávnění`);
      }
    }).pipe(Effect.ensuring(Effect.sync(unmountAll))),
  );
});
