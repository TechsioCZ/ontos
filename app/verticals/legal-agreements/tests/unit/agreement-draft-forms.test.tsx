// @rstest-environment happy-dom
// The contract forms of the agreements page as a person uses them: one Save button last in the footer, typing changes
// only the draft, a save goes out once against the revision the draft was read at, and leaving with unsaved input
// asks first. Only the generated clients, the reference credentials, the i18n runtime and the router are replaced.
import { saveLabelsFor } from '@app/admin-ui';
import type { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { ApplyCommandActionConflictProblemSchema } from '../../shared/apis/apply-command-action.ts';
import type { Contract } from '../../shared/apis/records.ts';
import {
  createAgreement,
  renewAgreement,
  savePeriodDraft,
} from '../../src/routes/[lang]/smlouvy/agreements-command.ts';
import { renewalDraftOf } from '../../src/routes/[lang]/smlouvy/agreement-draft.ts';
import type { CreateReferences } from '../../src/routes/[lang]/smlouvy/agreement-draft.ts';
import { ContractCreatePanel } from '../../src/routes/[lang]/smlouvy/contract-create-panel.tsx';
import { ContractPeriodPanel } from '../../src/routes/[lang]/smlouvy/contract-period-panel.tsx';
import {
  button,
  buttons,
  click,
  field,
  mount,
  pick,
  text,
  type,
  unmountAll,
  waitUntil,
} from '../support/agreement-form.tsx';

const { apply, credentials, records } = rstest.hoisted(() => ({
  apply: rstest.fn(),
  credentials: rstest.fn(),
  records: rstest.fn(),
}));

rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: apply }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: records }));
rstest.mock('@app/shared-contracts', () => {
  const actual = rstest.requireActual<{
    readonly makeReferenceGatewayCredentials: typeof makeReferenceGatewayCredentials;
  }>('@app/shared-contracts');
  return { ...actual, makeReferenceGatewayCredentials: credentials };
});
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useNavigate: () => () => {},
  useRouterState: () => '',
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const labels = saveLabelsFor('cs');
const close = 'legal-agreements.detail.close';
const noUnit = 'legal-agreements.demo.noUnit';
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

const sent = () => apply.mock.calls.map(([payload]) => payload);
const closed: string[] = [];
const created: string[] = [];

const mountPeriod = () =>
  mount(
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
  mount(
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
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apply.mockReset();
  records.mockReset();
  credentials.mockReset();
  credentials.mockReturnValue(Effect.void);
  apply.mockReturnValue(Effect.succeed({ resourceRef: contractRef, revision: 5 }));
  closed.length = 0;
  created.length = 0;
});

afterEach(() => {
  unmountAll();
  rstest.unstubAllGlobals();
});

describe('period of a draft contract', () => {
  it.effect(
    'typing sends nothing; one Save sends the contract as read once, then the panel closes without asking',
    () =>
      Effect.gen(function* saveOnce() {
        yield* mountPeriod();
        expect(buttons(labels.save)).toHaveLength(1);
        expect(button(labels.save).disabled).toBe(true);

        yield* type(endDate, '2028-01-31');
        expect(text()).toContain(labels.unsaved);
        // Enter submits the form natively: it must not save.
        field(endDate).form?.requestSubmit();
        yield* click(field(endDate));
        expect(text()).toContain(labels.unsaved);
        expect(sent()).toHaveLength(0);

        yield* click(button(labels.save));
        yield* waitUntil(() => text().includes(labels.saved));
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
      }),
  );

  it.effect('closing with unsaved input asks; Zůstat keeps it, Zahodit změny closes and sends nothing', () =>
    Effect.gen(function* leave() {
      yield* mountPeriod();
      yield* type(endDate, '2028-01-31');
      yield* click(button(close));
      expect(buttons(labels.discard)).toHaveLength(1);
      expect(closed).toEqual([]);

      yield* click(button(labels.stay));
      yield* waitUntil(() => buttons(labels.stay).length === 0);
      expect(field(endDate).value).toBe('2028-01-31');

      yield* click(button(close));
      yield* click(button(labels.discard));
      expect(closed).toEqual(['period']);
      expect(sent()).toHaveLength(0);
    }),
  );

  it.effect('Uložit in the question saves once and then closes', () =>
    Effect.gen(function* saveAndLeave() {
      yield* mountPeriod();
      yield* type(endDate, '2028-01-31');
      yield* click(button(close));
      yield* click(buttons(labels.save).at(-1));
      yield* waitUntil(() => closed.length === 1);
      expect(sent()).toHaveLength(1);
    }),
  );

  it.effect('someone else changed this contract: the save is refused as a conflict, never resent over it', () =>
    Effect.gen(function* refused() {
      apply.mockReturnValue(Effect.fail(conflictProblem));
      records.mockReturnValue(
        Effect.succeed({ contracts: [{ ...draftContract, subject: 'Jiný předmět' }], documents: [], revision: 7 }),
      );
      yield* mountPeriod();
      yield* type(endDate, '2028-01-31');
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(labels.conflict));
      expect(sent()).toHaveLength(1);
      expect(buttons(labels.reloadLatest)).toHaveLength(1);
    }),
  );

  it.effect('another contract changed: the save is resent once against the fresh revision', () =>
    Effect.gen(function* resent() {
      apply.mockReturnValueOnce(Effect.fail(conflictProblem));
      records.mockReturnValue(Effect.succeed({ contracts: [draftContract], documents: [], revision: 7 }));
      yield* mountPeriod();
      yield* type(endDate, '2028-01-31');
      yield* click(button(labels.save));
      yield* waitUntil(() => text().includes(labels.saved));
      expect(sent().map((payload) => payload.expectedRevision)).toEqual([4, 7]);
    }),
  );
});

describe('new contract', () => {
  it.effect('renewal opens an independent valid period and sends only the dates the person saves', () =>
    Effect.gen(function* renewalPeriodForm() {
      const previous: Contract = { ...draftContract, endDate: '2030-01-31', lifecycleState: 'ACTIVE' };
      yield* mount(
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
      expect(sent()).toEqual([]);
      // The suggested successor period is valid as it opens: Uložit could send it without retyping a date.
      expect(button(labels.save).disabled).toBe(false);
      yield* type(endDate, '2027-10-05');
      expect(button(labels.save).disabled).toBe(true);
      yield* type(endDate, '2032-02-01');
      yield* click(button(labels.save));
      yield* waitUntil(() => created.length === 1);
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
    }),
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
  it.effect('an untouched form closes without asking', () =>
    Effect.gen(function* untouched() {
      yield* mountCreate();
      expect(button(labels.save).disabled).toBe(true);
      yield* click(button(close));
      expect(buttons(labels.stay)).toHaveLength(0);
      expect(closed).toEqual(['create']);
    }),
  );

  it.effect('picking the customer enables the one Save; it creates the contract once and opens it', () =>
    Effect.gen(function* create() {
      yield* mountCreate();
      yield* pick('legal-agreements.demo.customer', 'party-1');
      expect(button(labels.save).disabled).toBe(false);
      document.querySelector('form')?.requestSubmit();
      yield* click(document.querySelector('form') ?? undefined);
      expect(sent()).toHaveLength(0);
      yield* click(button(labels.save));
      yield* waitUntil(() => created.length === 1);
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toMatchObject({
        command: { _tag: 'CreateContract', record: { counterpartyRef, kind: 'OTHER', lifecycleState: 'DRAFT' } },
        expectedRevision: 4,
      });
      expect(created).toEqual([contractRef.resourceId]);
    }),
  );

  it.effect('closing with a picked customer asks before the input is lost', () =>
    Effect.gen(function* leaveTyped() {
      yield* mountCreate();
      yield* pick('legal-agreements.demo.customer', 'party-1');
      yield* click(button(close));
      expect(buttons(labels.discard)).toHaveLength(1);
      yield* click(button(labels.discard));
      expect(closed).toEqual(['create']);
      expect(sent()).toHaveLength(0);
    }),
  );
});
