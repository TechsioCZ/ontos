// @rstest-environment happy-dom
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';

import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/apis/apply-command-action.ts';

import { termsCommandOf, termsDraftOf } from '../../src/routes/[lang]/smlouvy/contract-terms-draft.ts';
import { saveTerms } from '../../src/routes/[lang]/smlouvy/use-agreements-records.ts';
import type { Contract } from '../../shared/apis/records.ts';

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

const commands: (typeof ApplyCommandPayloadSchema.Encoded)[] = [];
const OwnerActionApi = ApplyCommandActionApi.prefix('/legal-agreements-api');
/** What the owner answers the next command with; each test sets it. */
let answer: ActionProposalAccepted | typeof ApplyCommandResultSchema.Type = proposal;
const network = browserNetwork(
  shellGatewayIssuer({ 'legal-agreements': '/legal-agreements-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return answer;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
);

beforeEach(() => {
  commands.length = 0;
  answer = proposal;
});

it.layer(network, { excludeTestServices: true })('contract terms save with approval', (suite) => {
  suite.effect('keeps terms parked for approval unsaved and reports the proposal', () =>
    Effect.gen(function* parked() {
      yield* pinTestDocument;
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
      expect(commands).toHaveLength(1);
    }),
  );

  suite.effect('adopts the committed revision and reports no proposal', () =>
    Effect.gen(function* committed() {
      yield* pinTestDocument;
      answer = yield* Schema.decodeUnknownEffect(ApplyCommandResultSchema)({ resourceRef: contractRef, revision: 5 });
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
