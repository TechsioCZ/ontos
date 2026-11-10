import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import {
  ActionAlreadyCommitted,
  ActiveApplicationCompositionService,
  ContextAccess,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import type { OperationalScope } from '@app/core-runtime';
import { makeAccessDecisionService } from '@app/core-runtime/access/enforcement';
import type { AccessPrincipalKind, GateInput } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { Effect, Layer, Option, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { storefrontInquiryCarrier, workRecordsCarrier } from '../../shared/access-declarations.ts';
import { SubmitStorefrontInquiryPayloadSchema } from '../../shared/actions/submit-storefront-inquiry.ts';
import { TaskSchema } from '../../shared/apis/records.ts';
import { workTasksMcpContribution } from '../../shared/mcp/contribution.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { submitStorefrontInquiryAction } from '../../src/actions/submit-storefront-inquiry.action.ts';
import { workTasksRegistration } from '../../vertical.registration.ts';
import { company, otherCompany, tenantId } from './search-fixtures.ts';

/*
 * The storefront inquiry Action is a workload carrier: Core's own decision service admits a storefront key only while
 * it holds an active `work.storefront-client` binding registered for the company it acts in. Every case below is
 * answered by `makeAccessDecisionService` itself, with only its identity and registry ports scripted.
 */

const storefront = '30000000-0000-4000-8000-000000000080';
const now = new Date('2026-11-10T12:00:00Z');

interface Registry {
  readonly companies?: readonly string[];
  readonly keys?: readonly string[];
  readonly kind?: AccessPrincipalKind;
}

const gateOf = (registry: Registry) =>
  makeAccessDecisionService({
    authorityFor: () => ({
      readCells: () => Effect.succeed([]),
      readConnection: () => Effect.succeed(Option.none()),
      readScope: () => Effect.succeed(Option.none()),
      readTeamIds: () => Effect.succeed([]),
    }),
    check: { checkBulk: (items) => Effect.succeed(items.map(() => ({ permissionship: 'none' as const }))) },
    decisionLog: { record: () => Effect.void },
    legalEntities: { listCandidateIds: () => Effect.succeed([LegalEntityIdSchema.make(company)]) },
    principalKinds: { readKind: () => Effect.succeed(Option.some(registry.kind ?? 'service')) },
    workloadBindings: {
      readActiveWorkloadKeys: () => Effect.succeed(new Set(registry.keys ?? ['work.storefront-client'])),
      readCompanyDeclaration: () =>
        Effect.succeed({
          activeCompanyIds: new Set((registry.companies ?? [company]).map((id) => LegalEntityIdSchema.make(id))),
          pinned: true,
        }),
    },
  });

/** The trusted scope a storefront key reaches the owner with: an API key of its own tenant and company. */
const storefrontScope = (legalEntityId: string = company): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '30000000-0000-4000-8000-000000000070',
    authContextRef: 'api_key:storefront-inquiry',
    authMethod: 'api_key',
    legalEntityId,
    principalId: storefront,
    tenantId,
  }),
  correlationId: 'storefront-inquiry',
});

const decide = (registry: Registry, carrier: GateInput['carrier'], scope = storefrontScope()) =>
  gateOf(registry)
    .decide({ carrier, legalEntityScope: 'required', now, scope })
    .pipe(Effect.map((decision) => ({ codes: decision.reasons.map(({ code }) => code), outcome: decision.outcome })));

const inquiryCarrier: GateInput['carrier'] = {
  accessWorkload: submitStorefrontInquiryAction.descriptor.accessWorkload,
};

const inquiry = {
  email: 'zakaznik@example.cz',
  kind: 'PRODUCT_QUESTION',
  message: 'Máte tento šroub i v nerezu?',
  name: 'Jana Nováková',
  productId: 'sku-123',
  productName: 'Šroub M8',
  requestId: '40000000-0000-4000-8000-000000000001',
  subject: 'Dotaz na produkt',
} as const;
const payload = { description: 'Kontakt: Jana Nováková', storefrontInquiry: inquiry, title: 'Dotaz: Šroub M8' };
/** The runtime decodes Action payloads with excess properties refused; the test decodes the same way. */
const decodePayload = Schema.decodeUnknownExit(SubmitStorefrontInquiryPayloadSchema, { onExcessProperty: 'error' });

it('declares only a workload carrier in the Work Tasks namespace, never a human capability', () => {
  expect(submitStorefrontInquiryAction.descriptor.accessDeclaration).toBeUndefined();
  expect(submitStorefrontInquiryAction.descriptor.accessWorkload?.workloads).toEqual(['work.storefront-client']);
  expect(storefrontInquiryCarrier.accessWorkload.workloads).toEqual(['work.storefront-client']);
  expect(submitStorefrontInquiryAction.descriptor.legalEntityScope).toBe('required');
  expect(submitStorefrontInquiryAction.descriptor.idempotency).toBe('required');
});

it.effect('admits a storefront key bound to work.storefront-client in its registered company', () =>
  Effect.gen(function* boundStorefront() {
    expect(yield* decide({}, inquiryCarrier)).toEqual({ codes: ['allow.workload'], outcome: 'ALLOWED' });
  }),
);

it.effect('refuses a storefront key bound only to another workload key', () =>
  Effect.gen(function* unboundStorefront() {
    expect(yield* decide({ keys: ['commerce.storefront-client'] }, inquiryCarrier)).toEqual({
      codes: ['deny.workload_unbound'],
      outcome: 'DENIED',
    });
    expect(yield* decide({ keys: [] }, inquiryCarrier)).toMatchObject({ codes: ['deny.workload_unbound'] });
  }),
);

it.effect('refuses another company than the one the key is registered for', () =>
  Effect.gen(function* foreignCompany() {
    expect(yield* decide({}, inquiryCarrier, storefrontScope(otherCompany))).toEqual({
      codes: ['deny.workload_unbound'],
      outcome: 'DENIED',
    });
    expect(yield* decide({ companies: [] }, inquiryCarrier)).toMatchObject({ codes: ['deny.workload_unbound'] });
  }),
);

it.effect('refuses people and agents: the Action is workload-only', () =>
  Effect.gen(function* humanCaller() {
    expect(yield* decide({ kind: 'human' }, inquiryCarrier)).toEqual({
      codes: ['deny.workload_only'],
      outcome: 'DENIED',
    });
    // An agent is refused before the carrier is read: it holds no agent connection on this key.
    expect(yield* decide({ kind: 'agent' }, inquiryCarrier)).toEqual({
      codes: ['deny.agent_forbidden'],
      outcome: 'DENIED',
    });
  }),
);

it.effect('keeps apply-command and the records read closed to the bound storefront key', () =>
  Effect.gen(function* otherCarriers() {
    const applyCommand = { accessDeclaration: applyCommandAction.descriptor.accessDeclaration };
    expect(applyCommandAction.descriptor.accessWorkload).toBeUndefined();
    expect(workRecordsCarrier).not.toHaveProperty('accessWorkload');
    for (const carrier of [applyCommand, workRecordsCarrier]) {
      expect(yield* decide({}, carrier)).toEqual({ codes: ['deny.workload_forbidden'], outcome: 'DENIED' });
    }
  }),
);

it('accepts the inquiry text and the inquiry itself, nothing else', () => {
  expect(decodePayload(payload)._tag).toBe('Success');
  expect(decodePayload({ storefrontInquiry: inquiry, title: 'Dotaz' })._tag).toBe('Success');
  expect(decodePayload({ description: 'bez dotazu', title: 'Dotaz' })._tag).toBe('Failure');
  expect(decodePayload({ ...payload, storefrontInquiry: { ...inquiry, requestId: 'not-a-uuid' } })._tag).toBe(
    'Failure',
  );
});

it('refuses every command tag and every field a storefront must not set', () => {
  const principalRef = { principalId: storefront, tenantId };
  for (const forbidden of [
    { _tag: 'CreateTask' },
    { _tag: 'UpdateTask' },
    { command: { _tag: 'CreateTask', title: 'Dotaz' } },
    { expectedRevision: 0 },
    { ownerPrincipalRef: principalRef },
    { priority: 'URGENT' },
    { dueDate: '2026-12-01' },
    { plannedHours: 2 },
    { projectId: 'project-1' },
    { partyId: '50000000-0000-4000-8000-000000000001' },
    { opportunityId: '50000000-0000-4000-8000-000000000002' },
    { contextRefs: [] },
    { state: 'DONE' },
    { tenantId },
    { legalEntityId: otherCompany },
  ]) {
    expect({ forbidden, result: decodePayload({ ...payload, ...forbidden })._tag }).toEqual({
      forbidden,
      result: 'Failure',
    });
  }
});

it('is hidden from the MCP catalogue, so no agent tool runs it', () => {
  expect(workTasksMcpContribution.actions['submit-storefront-inquiry']).toBe('hidden');
});

const unused = () => Effect.die('Unexpected boundary');
const runtimeDependencies = Layer.mergeAll(
  Layer.succeed(ActiveApplicationCompositionService, { load: unused() }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, { configuration: unused() }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://ontos.test/inquiry')),
  ),
  Layer.succeed(ContextAccess, {
    contextPermissions: unused,
    legalEntities: unused,
    modules: unused,
    resources: unused,
    tenants: unused,
  }),
);

it.layer(runtimeDependencies)('storefront inquiry Action', (suite) => {
  suite.effect('files one task, answers only its identity, queues one search refresh and replays nothing', () =>
    Effect.gen(function* fileInquiry() {
      const filed: unknown[] = [];
      const task = Schema.decodeSync(TaskSchema)({
        collectionRef: {
          moduleId: 'work.tasks',
          resourceId: 'default',
          resourceType: 'work.tasks.task-collection',
          tenantId,
        },
        contextRefs: [],
        createdAt: '2026-11-10T12:00:00Z',
        description: 'Kontakt: Jana Nováková',
        priority: 'NORMAL',
        ref: { moduleId: 'work.tasks', resourceId: 'inquiry-task', resourceType: 'work.tasks.task', tenantId },
        state: 'NEW',
        storefrontInquiry: inquiry,
        title: 'Dotaz: Šroub M8',
        updatedAt: '2026-11-10T12:00:00Z',
      });
      const harness = yield* makeActionTestHarness({
        access: 'allowed',
        ownerRegistration: workTasksRegistration,
        services: [
          bindActionTestServices(submitStorefrontInquiryAction, {
            apply: unused,
            loadRecords: unused,
            submitStorefrontInquiry: (command) =>
              Effect.sync(() => {
                filed.push(command);
                return { revision: 3, task };
              }),
          }),
        ],
      });
      const input = {
        payload: yield* Schema.decodeEffect(SubmitStorefrontInquiryPayloadSchema)(payload),
        principal: storefrontScope(),
        registration: submitStorefrontInquiryAction,
        transport: { correlationId: 'storefront-inquiry', idempotencyKey: `sf-inquiry-${inquiry.requestId}` },
      };
      // Exactly the acknowledgement: no task fields, revision or other records travel back to the storefront.
      expect(yield* harness.runtime.runAction(input)).toEqual({ requestId: inquiry.requestId, taskRef: task.ref });
      // The owner receives a plain CreateTask with the inquiry: no assignee, priority or other field is invented.
      expect(filed).toEqual([{ _tag: 'CreateTask', ...payload }]);
      expect(harness.snapshot().committed[0]?.evidence.outboxMessages).toMatchObject([
        { message: { producerModuleKey: 'work.tasks', topic: 'work.tasks.search-refresh-requested.v1' } },
      ]);
      const replay = yield* harness.runtime.runAction(input).pipe(Effect.flip);
      expect(Schema.is(ActionAlreadyCommitted)(replay)).toBe(true);
      expect(filed).toHaveLength(1);
      expect(harness.snapshot().committed).toHaveLength(1);
    }),
  );
});
