// @rstest-environment happy-dom
// The edit dialog of a building while the register reloads in the background (a live change, the 20 s freshness
// window, a settled write). The strict register store reads `pending` during such a reload; the open dialog must stay
// mounted: typed input, its unsaved status and the leave question survive, a save goes out against the revision the
// draft was read at, and a draft with nothing typed takes the reloaded building.
// The page runs on its real i18n, router and generated clients; the Shell's gateway issuer, the property owner's
// records and Action endpoints and Workforce's records endpoint answer in process through their HttpApi contracts.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, settle, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import {
  RecordsApi as WorkforceRecordsApi,
  RecordsResponseSchema as WorkforceRecordsSchema,
} from '@app/workforce/contracts/records';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';

import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { RecordsPage } from '../../src/routes/[lang]/nemovitosti/page.tsx';
import { propertyRecords } from '../../src/routes/[lang]/nemovitosti/property-summary.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const tenantId = '70000000-0000-4000-8000-000000000020';
const employeeId = '75000000-0000-4000-8000-000000000001';
const firstId = '76000000-0000-4000-8000-000000000001';
const secondId = '76000000-0000-4000-8000-000000000002';
const propertyOf = (resourceId: string, address: string) => ({
  address,
  code: resourceId === firstId ? 'PROPERTY-01' : 'PROPERTY-02',
  createdAt: '2026-10-27T09:00:00.000Z',
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '71000000-0000-4000-8000-000000000020',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  lifecycleState: 'ACTIVE',
  name: resourceId === firstId ? 'server-name' : 'second-name',
  note: null,
  propertyRef: {
    moduleId: 'property.portfolio',
    resourceId,
    resourceType: 'property.portfolio.property',
    tenantId,
  },
  propertyType: 'Residential',
  responsibleEmployeeIds: [employeeId],
  updatedAt: '2026-10-27T09:00:00.000Z',
});
/** The register at `revision`; every read is a new object, as a reload returns. */
const recordsAt = (revision: number, address: string): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    assets: [],
    properties: [propertyOf(firstId, address), propertyOf(secondId, 'second-address')],
    revision,
    units: [],
  });
/** Workforce's employees, the responsible-person choices. */
const workforceRecords = Schema.decodeUnknownSync(WorkforceRecordsSchema)({
  actorPrincipalRef: { principalId: '72000000-0000-4000-8000-000000000001', tenantId },
  availablePrincipals: [],
  canWrite: false,
  indicators: {
    active: 1,
    byDepartment: [],
    byRole: { ACCOUNTANT: 0, SALES_HEAD: 0, SALES_REP: 0, SUPPORT: 1, WAREHOUSE: 0 },
    total: 1,
  },
  items: [
    {
      active: true,
      createdAt: '2026-10-27T09:00:00.000Z',
      department: 'Správa',
      email: 'jana@example.test',
      fullName: 'Jana',
      id: employeeId,
      role: 'SUPPORT',
      updatedAt: '2026-10-27T09:00:00.000Z',
    },
  ],
  revision: 1,
});
const saved = Schema.decodeUnknownSync(ApplyCommandResultSchema)({
  resourceRef: {
    moduleId: 'property.portfolio',
    resourceId: firstId,
    resourceType: 'property.portfolio.property',
    tenantId,
  },
  revision: 6,
});

const context: ModulePageProps['context'] = { legalEntityId: 'company-a', principalId: 'manager-a', tenantId };

const name = 'property-name';
const address = 'property-address';
const czech = moduleText('cs');
const edit = czech('property-portfolio.pages.records.editor.edit');
const close = czech('property-portfolio.pages.records.editor.close');

/** What the property owner answers the next records read with; each test scripts it. */
let answer: Effect.Effect<RecordsResponse> = Effect.succeed(recordsAt(4, 'server-address'));
/** Every records read and command the property owner received, in order. */
const reads: RecordsRequest[] = [];
const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];

const OwnerRecordsApi = RecordsApi.prefix('/property-portfolio-api');
const OwnerActionApi = ApplyCommandActionApi.prefix('/property-portfolio-api');
const WorkforceApi = WorkforceRecordsApi.prefix('/workforce-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'property-portfolio': '/property-portfolio-api', workforce: '/workforce-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          reads.push(payload);
          return answer;
        }),
      ),
    ),
  ),
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return saved;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    WorkforceApi,
    HttpApiBuilder.group(WorkforceApi, 'records', (group) =>
      group.handle('execute', () => Effect.succeed(workforceRecords)),
    ),
  ),
);

const button = (label: string): HTMLButtonElement => {
  const [found] = buttons(label);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};
const maybeField = (id: string) => Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${id}"]`));
const value = (id: string) =>
  maybeField(id).pipe(
    Option.map((input) => input.value),
    Option.getOrUndefined,
  );
const type = (id: string, typed: string) =>
  acted(() => {
    const input = Option.getOrThrow(maybeField(id));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, typed);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const click = (label: string) => acted(() => button(label).click());

/** Opens the page on `resourceId` with the register at revision 4 and opens its edit dialog. */
const openEdit = (resourceId: string) =>
  Effect.gen(function* open() {
    yield* pinTestDocument;
    const mounted = yield* mountInRoute(<RecordsPage context={context} />, {
      path: 'nemovitosti',
      url: `/cs/nemovitosti?resourceId=${resourceId}`,
    });
    yield* waitUntil(() => buttons(edit).length === 1 && !button(edit).disabled);
    yield* click(edit);
    yield* waitUntil(() => Option.isSome(maybeField(name)));
    return mounted;
  });

/** A background reload of the register that the owner answers once `gate` opens; resolves once the read arrived. */
const reloadThrough = (gate: Deferred.Deferred<RecordsResponse>) =>
  Effect.gen(function* reload() {
    const arrived = yield* Deferred.make<true>();
    answer = Deferred.succeed(arrived, true).pipe(Effect.andThen(Deferred.await(gate)));
    yield* acted(() => propertyRecords.invalidate());
    yield* Deferred.await(arrived);
    yield* settle;
  });

beforeEach(() => {
  reads.length = 0;
  commands.length = 0;
  answer = Effect.succeed(recordsAt(4, 'server-address'));
  propertyRecords.invalidate();
});

afterEach(unmountAll);

it.layer(network, { excludeTestServices: true })('property edit dialog across a background reload', (suite) => {
  suite.effect('keeps typed input, its status and the leave question; Save sends it against the old revision', () =>
    Effect.gen(function* typedSurvives() {
      yield* openEdit(firstId);
      yield* type(name, 'typed-name');
      expect(text()).toContain(labels.unsaved);

      const gate = yield* Deferred.make<RecordsResponse>();
      yield* reloadThrough(gate);
      // While the register reads `pending`, the dialog and the typed value stay on screen.
      expect(value(name)).toBe('typed-name');
      expect(text()).toContain(labels.unsaved);

      yield* Deferred.succeed(gate, recordsAt(5, 'someone-else-address'));
      yield* waitUntil(() => reads.length >= 2 && text().includes('someone-else-address'));
      expect(value(name)).toBe('typed-name');
      // A dirty draft keeps its whole input, not just the typed field.
      expect(value(address)).toBe('server-address');
      expect(text()).toContain(labels.unsaved);
      expect(button(labels.save).disabled).toBe(false);

      yield* click(close);
      yield* waitUntil(() => buttons(labels.stay).length === 1);
      yield* click(labels.stay);
      yield* waitUntil(() => buttons(labels.stay).length === 0);
      expect(value(name)).toBe('typed-name');

      answer = Effect.succeed(recordsAt(5, 'someone-else-address'));
      yield* click(labels.save);
      yield* waitUntil(() => commands.length > 0);
      expect(commands[0]).toMatchObject({
        command: { name: 'typed-name' },
        expectedRevision: 4,
      });
    }),
  );

  suite.effect('another building never shows the draft typed for this one', () =>
    Effect.gen(function* otherBuilding() {
      const { router } = yield* openEdit(firstId);
      yield* type(name, 'typed-name');
      yield* click(close);
      yield* waitUntil(() => buttons(labels.discard).length === 1);
      yield* click(labels.discard);
      yield* waitUntil(() => Option.isNone(maybeField(name)));
      yield* acted(() => {
        router.history.push(`/cs/nemovitosti?resourceId=${secondId}`);
      });
      yield* waitUntil(() => buttons(edit).length === 1);
      yield* click(edit);
      yield* waitUntil(() => Option.isSome(maybeField(name)));
      expect(value(name)).toBe('second-name');
      expect(text()).not.toContain('typed-name');
    }),
  );
});
