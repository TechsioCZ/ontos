// @rstest-environment happy-dom
import { text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { RecordsApi as AgreementsApi, RecordsForbiddenProblemSchema } from '@app/legal-agreements/contracts/records';
import { RecordsApi as OccupancyApi } from '@app/property-leasing/contracts/records';
import { RecordsApi as PropertyApi } from '@app/property-portfolio/contracts/records';
import { RecordsApi as FinanceApi } from '@app/finance-billing/contracts/records';
import { RecordsApi as WorkApi } from '@app/work-tasks/contracts/records';
import { RecordsApi as SalesApi } from '@app/sales-pipeline/contracts/records';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import {
  CustomerListApi,
  CustomerListForbiddenProblemSchema,
} from '../../../party-registry/shared/apis/customer-list.ts';
import { OverviewApi, OverviewForbiddenProblemSchema } from '../../shared/apis/overview.ts';
import { preloadPage } from '../../src/routes/[lang]/provoz/prehled/page.tsx';
import { useRentalOverviewSources } from '../../src/ui/ops-agenda/sources.ts';
import { mountInRoute } from '../support/module-ui.ts';

const problem = {
  detail: 'Owner refused this read',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:forbidden',
} satisfies Parameters<typeof RecordsForbiddenProblemSchema.make>[0];
const forbidden = RecordsForbiddenProblemSchema.make(problem);
const Agreements = AgreementsApi.prefix('/legal-agreements-api');
const Occupancy = OccupancyApi.prefix('/property-leasing-api');
const Property = PropertyApi.prefix('/property-portfolio-api');
const Finance = FinanceApi.prefix('/finance-billing-api');
const Work = WorkApi.prefix('/work-tasks-api');
const Sales = SalesApi.prefix('/sales-pipeline-api');
const Customers = CustomerListApi.prefix('/party-registry-api');
const Overview = OverviewApi.prefix('/facility-operations-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'facility-operations': '/facility-operations-api',
    'finance-billing': '/finance-billing-api',
    'legal-agreements': '/legal-agreements-api',
    'party-registry': '/party-registry-api',
    'property-leasing': '/property-leasing-api',
    'property-portfolio': '/property-portfolio-api',
    'sales-pipeline': '/sales-pipeline-api',
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
    Property,
    HttpApiBuilder.group(Property, 'records', (g) => g.handle('execute', () => Effect.fail(forbidden))),
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
    Sales,
    HttpApiBuilder.group(Sales, 'records', (g) => g.handle('execute', () => Effect.fail(forbidden))),
  ),
  serveApi(
    Customers,
    HttpApiBuilder.group(Customers, 'customerList', (g) =>
      g.handle('execute', () => Effect.fail(CustomerListForbiddenProblemSchema.make(problem))),
    ),
  ),
  serveApi(
    Overview,
    HttpApiBuilder.group(Overview, 'overview', (g) =>
      g.handle('execute', () => Effect.fail(OverviewForbiddenProblemSchema.make(problem))),
    ),
  ),
);
const SourceResults = () => {
  const { sources } = useRentalOverviewSources();
  return (
    <>
      {Object.entries(sources).map(([key, value]) => (
        <output key={key}>
          {key}: {value.status};
        </output>
      ))}
    </>
  );
};
afterEach(unmountAll);

it.live('opening the operations overview settles every independent source with its owner permission result', () =>
  Effect.gen(function* sourcePermissions() {
    yield* pinTestDocument;
    yield* Effect.promise(() => preloadPage({ routeParams: {}, search: '' }));
    yield* mountInRoute(<SourceResults />, { path: 'provoz/prehled', url: '/cs/provoz/prehled' });
    yield* waitUntil(() => !text().includes('loading'));
    for (const source of ['agreements', 'occupancy', 'property', 'finance', 'work', 'sales', 'parties', 'ops']) {
      expect(text()).toContain(`${source}: forbidden;`);
    }
  }).pipe(Effect.ensuring(Effect.sync(unmountAll)), Effect.provide(network)),
);
