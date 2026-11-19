// @rstest-environment happy-dom
// The contract forms of the agreements page as a person uses them: one Save button last in the footer, typing changes
// only the draft, a save goes out once against the revision the draft was read at, and leaving with unsaved input
// asks first. The real clients, reference credentials, i18n, router and UI run against in-process HTTP contracts.
import { saveLabelsFor } from '@app/admin-ui';
import { unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import {
  ApplyCommandActionApi,
  ApplyCommandActionConflictProblemSchema,
} from '../../shared/apis/apply-command-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { Contract, RecordsResponse } from '../../shared/apis/records.ts';
import {
  createAgreement,
  renewAgreement,
  savePeriodDraft,
} from '../../src/routes/[lang]/smlouvy/agreements-command.ts';
import { renewalDraftOf } from '../../src/routes/[lang]/smlouvy/agreement-draft.ts';
import type { CreateReferences } from '../../src/routes/[lang]/smlouvy/agreement-draft.ts';
import { ContractCreatePanel } from '../../src/routes/[lang]/smlouvy/contract-create-panel.tsx';
import { ContractPeriodPanel } from '../../src/routes/[lang]/smlouvy/contract-period-panel.tsx';
import { button, buttons, click, field, pick, text, type } from '../support/agreement-form.tsx';

import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const czech = moduleText('cs');
const close = czech('legal-agreements.detail.close');
const noUnit = czech('legal-agreements.demo.noUnit');
const tenantId = '11111111-1111-4111-8111-111111111111';
const contractRef = {
  moduleId: 'legal.agreements',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'legal.agreements.contract',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const draftContract: Contract = {
  contractRef,
  counterpartyRef,
  endDate: '2027-10-05',
  kind: 'OTHER',
  lifecycleState: 'DRAFT',
  note: null,
  occupancyRef: null,
  propertyRef: null,
  renewalNoticeDate: null,
  signatureState: 'NOT_SENT',
  startDate: '2026-10-05',
  subject: 'Servis výtahů',
  supersedesContractRef: null,
  unitRef: null,
};
const references: CreateReferences = {
  customers: [{ counterpartyRef, partyId: 'party-1', status: 'ACTIVE' }],
  occupancies: [],
  units: [],
};
const conflictProblem = Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
  _tag: 'ApplyCommandActionConflictProblem',
  code: 'agreements_conflict',
  detail: 'Smlouvy se mezitím změnily.',
  status: 409,
  title: 'Konflikt',
  type: 'about:blank',
});

const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
const sent = () => commands;
const saved = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ resourceRef: contractRef, revision: 5 });
let answer: Effect.Effect<typeof ApplyCommandResultSchema.Type, typeof ApplyCommandActionConflictProblemSchema.Type> =
  Effect.succeed(saved);
const recordsAt = (contracts: readonly Contract[]): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    contracts: contracts.map((contract) => ({
      ...contract,
      expiringSoon: false,
      hasSuccessorDraft: false,
      isExpired: false,
    })),
    documents: [],
    revision: 7,
  });
let recordsAnswer = recordsAt([draftContract]);
const OwnerActionApi = ApplyCommandActionApi.prefix('/legal-agreements-api');
const OwnerRecordsApi = RecordsApi.prefix('/legal-agreements-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'legal-agreements': '/legal-agreements-api',
    'party-registry': '/party-registry-api',
  }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          commands.push(payload);
          return answer;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', () => Effect.sync(() => recordsAnswer)),
    ),
  ),
);
const closed: string[] = [];
const created: string[] = [];

const mountPeriod = () =>
  mountInRoute(
    <ContractPeriodPanel
      contract={draftContract}
      label={noUnit}
      onClose={() => {
        closed.push('period');
      }}
      onSave={savePeriodDraft}
      reload={Effect.void}
      revision={4}
    />,
  );

const mountCreate = () =>
  mountInRoute(
    <ContractCreatePanel
      customers={[{ label: 'party-1', value: 'party-1' }]}
      kind="OTHER"
      leases={[]}
      onClose={() => {
        closed.push('create');
      }}
      onCreate={(draft) => createAgreement(draft, { expectedRevision: 4, references })}
      onCreated={(resourceId) => {
        created.push(resourceId);
      }}
      onKindChange={() => {}}
      references={references}
    />,
  );

const endDate = 'contract-end-date';

beforeEach(() => {
  commands.length = 0;
  answer = Effect.succeed(saved);
  recordsAnswer = recordsAt([draftContract]);
  closed.length = 0;
  created.length = 0;
});

afterEach(unmountAll);

describe('period of a draft contract', () => {
  it.live('typing sends nothing; one Save sends the contract as read once, then the panel closes without asking', () =>
    Effect.gen(function* saveOnce() {
      yield* pinTestDocument;
      yield* mountPeriod();
      expect(buttons(labels.save)).toHaveLength(1);
      expect(button(labels.save).disabled).toBe(true);

      yield* type(endDate, '2028-01-31');
      expect(text()).toContain(labels.unsaved);
      // Enter submits the form natively: it must not save.
      field(endDate).form?.requestSubmit();
      yield* click(field(endDate));
      expect(text()).toContain(labels.unsaved);
      yield* networkIdle;
      expect(sent()).toHaveLength(0);

      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(labels.saved));
      yield* networkIdle;
      expect(sent()).toEqual([
        {
          command: {
            _tag: 'UpdateContract',
            record: { ...draftContract, endDate: '2028-01-31' },
          },
          expectedRevision: 4,
        },
      ]);

      yield* click(button(close));
      expect(buttons(labels.stay)).toHaveLength(0);
      expect(closed).toEqual(['period']);
    }).pipe(Effect.provide(network)),
  );

  it.live('someone else changed this contract: the save is refused as a conflict, never resent over it', () =>
    Effect.gen(function* refused() {
      yield* pinTestDocument;
      answer = Effect.fail(conflictProblem);
      recordsAnswer = recordsAt([{ ...draftContract, subject: 'Jiný předmět' }]);
      yield* mountPeriod();
      yield* type(endDate, '2028-01-31');
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(labels.conflict));
      yield* networkIdle;
      expect(sent()).toHaveLength(1);
      expect(buttons(labels.reloadLatest)).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );

  it.live('another contract changed: the save is resent once against the fresh revision', () =>
    Effect.gen(function* resent() {
      yield* pinTestDocument;
      answer = Effect.suspend(() => (commands.length === 1 ? Effect.fail(conflictProblem) : Effect.succeed(saved)));
      yield* mountPeriod();
      yield* type(endDate, '2028-01-31');
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(labels.saved));
      yield* networkIdle;
      expect(sent().map((payload) => payload.expectedRevision)).toEqual([4, 7]);
    }).pipe(Effect.provide(network)),
  );
});

describe('new contract', () => {
  it.live('renewal opens an independent valid period and sends only the dates the person saves', () =>
    Effect.gen(function* renewalPeriodForm() {
      yield* pinTestDocument;
      const previous: Contract = { ...draftContract, endDate: '2030-01-31', lifecycleState: 'ACTIVE' };
      yield* mountInRoute(
        <ContractCreatePanel
          customers={[]}
          kind={previous.kind}
          leases={[]}
          onClose={() => {}}
          onCreate={(draft) => renewAgreement(draft, { expectedRevision: 4, previous })}
          onCreated={(resourceId) => {
            created.push(resourceId);
          }}
          onKindChange={() => {}}
          references={references}
          renewal={{ opening: renewalDraftOf(previous, '2026-11-14'), previous }}
        />,
      );
      expect(field('contract-start-date').value).toBe('2030-01-31');
      expect(field(endDate).value).toBe('2031-01-31');
      yield* networkIdle;
      expect(sent()).toEqual([]);
      // The suggested successor period is valid as it opens: Uložit could send it without retyping a date.
      expect(button(labels.save).disabled).toBe(false);
      yield* type(endDate, '2027-10-05');
      expect(button(labels.save).disabled).toBe(true);
      yield* type(endDate, '2032-02-01');
      yield* click(button(labels.save));
      yield* waitUntil(() => created.length === 1);
      yield* networkIdle;
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toMatchObject({
        command: {
          _tag: 'RenewContract',
          contractRef,
          successor: {
            counterpartyRef,
            endDate: '2032-02-01',
            lifecycleState: 'DRAFT',
            startDate: '2030-01-31',
            supersedesContractRef: contractRef,
          },
        },
      });
    }).pipe(Effect.provide(network)),
  );

  it('initializes open-ended and leap-day renewals with valid independent dates', () => {
    expect(renewalDraftOf({ ...draftContract, endDate: null }, '2030-02-01')).toMatchObject({
      endDate: '2031-02-01',
      startDate: '2030-02-01',
    });
    expect(renewalDraftOf({ ...draftContract, endDate: '2028-02-29' }, '2026-11-14')).toMatchObject({
      endDate: '2029-02-28',
      startDate: '2028-02-29',
    });
  });

  it.live('picking the customer enables the one Save; it creates the contract once and opens it', () =>
    Effect.gen(function* create() {
      yield* pinTestDocument;
      yield* mountCreate();
      yield* pick(czech('legal-agreements.demo.customer'), 'party-1');
      expect(button(labels.save).disabled).toBe(false);
      document.querySelector('form')?.requestSubmit();
      yield* click(document.querySelector('form') ?? undefined);
      yield* networkIdle;
      expect(sent()).toHaveLength(0);
      yield* click(button(labels.save));
      yield* waitUntil(() => created.length === 1);
      yield* networkIdle;
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toMatchObject({
        command: { _tag: 'CreateContract', record: { counterpartyRef, kind: 'OTHER', lifecycleState: 'DRAFT' } },
        expectedRevision: 4,
      });
      expect(created).toEqual([contractRef.resourceId]);
    }).pipe(Effect.provide(network)),
  );
});
