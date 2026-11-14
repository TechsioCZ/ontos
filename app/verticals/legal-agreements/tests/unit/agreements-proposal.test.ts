import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { Effect, Option, Schema } from 'effect';
import { beforeEach, describe, expect, it, rstest } from 'effect-rstest';

import { termsCommandOf, termsDraftOf } from '../../src/routes/[lang]/smlouvy/contract-terms-draft.ts';
import { saveTerms } from '../../src/routes/[lang]/smlouvy/use-agreements-records.ts';
import type { Contract } from '../../shared/apis/records.ts';

const { apply, records } = rstest.hoisted(() => ({ apply: rstest.fn(), records: rstest.fn() }));

rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: apply }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: records }));
rstest.mock('@app/party-registry/apis/counterparty-read/client', () => ({
  executeCounterpartyRead: rstest.fn(),
}));
rstest.mock('../../src/routes/[lang]/smlouvy/party-customers.ts', () => ({
  listCustomers: rstest.fn(),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({ useNavigate: () => () => {}, useRouterState: () => '' }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({ useModernI18n: () => ({ language: 'cs', t: String }) }));

const tenantId = '11111111-1111-4111-8111-111111111111';
const contractRef = {
  moduleId: 'legal.agreements',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'legal.agreements.contract',
  tenantId,
} as const;
const contract: Contract = {
  contractRef,
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  endDate: '2027-10-05',
  kind: 'LEASE',
  lifecycleState: 'ACTIVE',
  note: null,
  occupancyRef: null,
  propertyRef: null,
  renewalNoticeDate: null,
  rentTerms: { currency: 'CZK', monthlyRentMinor: 1_850_000, paymentDay: 15, serviceChargesMinor: 250_050 },
  responsiblePerson: 'Jana Nováková',
  signatureState: 'SIGNED',
  startDate: '2026-10-05',
  subject: 'Nájem kanceláře',
  supersedesContractRef: null,
  unitRef: null,
};
const command = Option.getOrThrow(termsCommandOf(contractRef, { ...termsDraftOf(contract), monthly: '19000' }));
const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-11-14T10:00:00.000Z',
  proposalId: '77777777-7777-4777-8777-777777777777',
});

beforeEach(() => {
  apply.mockReset();
  records.mockReset();
});

describe('contract terms save with approval', () => {
  it.effect('keeps terms parked for approval unsaved and reports the proposal', () =>
    Effect.gen(function* parked() {
      apply.mockReturnValue(Effect.succeed(proposal));
      const reported: ActionProposalAccepted[] = [];
      const result = yield* saveTerms(
        command,
        4,
        () => true,
        (value) => {
          reported.push(value);
        },
      );
      expect(result).toBe('proposed');
      expect(reported).toEqual([proposal]);
      expect(apply).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect('adopts the committed revision and reports no proposal', () =>
    Effect.gen(function* committed() {
      apply.mockReturnValue(Effect.succeed({ resourceRef: contractRef, revision: 5 }));
      const reported: ActionProposalAccepted[] = [];
      const result = yield* saveTerms(
        command,
        4,
        () => true,
        (value) => {
          reported.push(value);
        },
      );
      expect(result).toBe(5);
      expect(reported).toEqual([]);
    }),
  );
});
