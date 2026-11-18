// @rstest-environment happy-dom
// Investment saves use the real router, i18n, generated clients and owner HTTP contracts.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  RecordsApi as PropertyRecordsApi,
  RecordsResponseSchema as PropertyRecordsResponseSchema,
} from '@app/property-portfolio/contracts/records';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import {
  ApplyCommandActionApi,
  ApplyCommandActionConflictProblemSchema,
} from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { AssetsStateSchema, InvestmentSchema } from '../../shared/domain/assets.ts';
import type { Investment } from '../../shared/domain/assets.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import { InvestmentForm } from '../../src/routes/[lang]/provoz/majetek/investments.tsx';
import { runCommand } from '../../src/ui/use-agenda.ts';
import { mountInRoute } from '../support/module-ui.ts';

const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const investmentAt = (updatedAt: string, responsible: string): Investment =>
  Schema.decodeUnknownSync(InvestmentSchema)({
    createdAt: '2026-10-20T08:00:00Z',
    createdBy: actor,
    id: 'investment-1',
    plannedAmountMinor: 25_000_000,
    plannedDate: '2027-04-01',
    priority: 'medium',
    responsible,
    status: 'planned',
    title: 'Výměna kotle',
    updatedAt,
    updatedBy: actor,
  });
const opened = investmentAt('2026-10-20T08:00:00Z', 'Jan Novák');
const theirs = investmentAt('2026-10-21T09:30:00Z', 'Eva Malá');
const stateWith = (investment?: Investment) =>
  Schema.decodeUnknownSync(AssetsStateSchema)({
    assets: [],
    investments: investment === undefined ? [] : [Schema.encodeSync(InvestmentSchema)(investment)],
  });
const saved: string[] = [];
const onSaved = () => {
  saved.push('saved');
};
const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
let revision = 3;
const conflict = Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
  _tag: 'ApplyCommandActionConflictProblem',
  code: 'facility_operations_revision_conflict',
  detail: 'The investment changed after this draft was opened.',
  status: 409,
  title: 'Revision conflict',
  type: 'urn:ontos:test:revision-conflict',
});
const history = Schema.decodeUnknownSync(RecordsResponseSchema)({
  access: [],
  actorPrincipalRef: actor,
  agendas: {},
  history: [],
});
const properties = Schema.decodeUnknownSync(PropertyRecordsResponseSchema)({
  assets: [],
  properties: [],
  revision: 0,
  units: [],
});
const OwnerAction = ApplyCommandActionApi.prefix('/facility-operations-api');
const OwnerRecords = RecordsApi.prefix('/facility-operations-api');
const PropertyOwner = PropertyRecordsApi.prefix('/property-portfolio-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'facility-operations': '/facility-operations-api',
    'property-portfolio': '/property-portfolio-api',
  }).application,
  serveApi(
    OwnerAction,
    HttpApiBuilder.group(OwnerAction, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          commands.push(payload);
          if (payload.expectedRevision < revision) {
            return Effect.fail(conflict);
          }
          revision += 1;
          return Effect.succeed({ entityIds: [], revision });
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecords,
    HttpApiBuilder.group(OwnerRecords, 'records', (group) => group.handle('execute', () => Effect.succeed(history))),
  ),
  serveApi(
    PropertyOwner,
    HttpApiBuilder.group(PropertyOwner, 'records', (group) =>
      group.handle('execute', () => Effect.succeed(properties)),
    ),
  ),
);
const runnerAt = (expectedRevision: number) => (command: OpsCommand) => runCommand(command, expectedRevision);
const editOf = (investment: Investment, expectedRevision: number) => (
  <InvestmentForm
    investment={opened}
    onSubmit={{ onSaved, run: runnerAt(expectedRevision) }}
    state={stateWith(investment)}
  />
);
const labels = saveLabelsFor('cs');
const field = (selector: string) =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(selector)));
const typeInto = (selector: string, value: string) =>
  acted(() => {
    const input = field(selector);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const click = (label: string) =>
  acted(() => {
    Option.getOrThrow(Option.fromUndefinedOr(buttons(label)[0])).click();
  });
const save = (count: number) =>
  click(labels.save).pipe(
    Effect.andThen(waitUntil(() => commands.length >= count)),
    Effect.andThen(waitUntil(() => buttons(labels.save).length > 0)),
  );

beforeEach(() => {
  saved.length = 0;
  commands.length = 0;
  revision = 3;
});
afterEach(unmountAll);

describe('investment plan item', () => {
  it.live('a new item is created once with the typed values', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountInRoute(<InvestmentForm onSubmit={{ onSaved, run: runnerAt(3) }} state={stateWith()} />, {
        url: '/cs/provoz/majetek',
      });
      yield* typeInto('#investment-title', 'Nová střecha');
      yield* typeInto('#investment-planned', '400 000');
      yield* typeInto('#investment-planned-date', '2027-06-01');
      yield* save(1);
      yield* waitUntil(() => saved.length === 1);
      expect(commands.map((entry) => entry.command)).toEqual([
        expect.objectContaining({
          _tag: 'AssetInvestmentCreate',
          plannedAmountMinor: 40_000_000,
          plannedDate: '2027-06-01',
          title: 'Nová střecha',
        }),
      ]);
      expect(saved).toEqual(['saved']);
    }).pipe(Effect.provide(network)),
  );

  it.live('an edit over someone else’s newer change is refused as a conflict; reload latest takes their version', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const panel = yield* mountInRoute(editOf(opened, 3), { url: '/cs/provoz/majetek' });
      yield* typeInto('#investment-responsible', 'Petr Dvořák');
      revision = 4;
      yield* panel.rerender(editOf(theirs, 4));
      yield* save(1);
      yield* waitUntil(() => text().includes(labels.conflict));
      expect(commands.map((entry) => entry.expectedRevision)).toEqual([3]);
      expect(text()).toContain(labels.conflict);
      expect(saved).toEqual([]);
      yield* click(labels.reloadLatest);
      expect(field('#investment-responsible').value).toBe('Eva Malá');
      yield* typeInto('#investment-responsible', 'Petr Dvořák');
      yield* save(2);
      yield* waitUntil(() => saved.length === 1);
      expect(commands.map((entry) => entry.expectedRevision)).toEqual([3, 4]);
      expect(Predicate.isTagged(commands[1]?.command, 'AssetInvestmentUpdate')).toBe(true);
      expect(commands[1]?.command).toMatchObject({ investmentId: opened.id, responsible: 'Petr Dvořák' });
      expect(saved).toEqual(['saved']);
    }).pipe(Effect.provide(network)),
  );
});
