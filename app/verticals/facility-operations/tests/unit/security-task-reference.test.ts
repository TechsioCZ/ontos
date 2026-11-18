// @rstest-environment happy-dom
import { beforeEach, expect, it } from 'effect-rstest';
import { Effect, Layer, Option, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { ApplyCommandResultSchema } from '@app/work-tasks/contracts/apply-command';
import type { ApplyCommandPayloadSchema } from '@app/work-tasks/contracts/apply-command';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { RecordsApi, RecordsResponseSchema } from '@app/work-tasks/contracts/records';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { applyCommandActionSchemaErrorLive } from '../../../work-tasks/api/apply-command-action-problems.ts';
import {
  ApplyCommandActionApi,
  ApplyCommandActionConflictProblemSchema,
  ApplyCommandActionUnavailableProblemSchema,
} from '../../../work-tasks/shared/apis/apply-command-action.ts';
import type { ApplyCommandActionProblem } from '../../../work-tasks/shared/apis/apply-command-action.ts';
import { createServiceTask } from '../../src/routes/[lang]/provoz/bezpecnost/security-model.ts';
import { SecurityDeviceSchema } from '../../shared/domain/security.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const propertyId = 'f5ef97e9-2935-4ebc-83e6-aa9d475e561b';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const at = '2026-10-20T08:00:00Z';
const device = Schema.decodeUnknownSync(SecurityDeviceSchema)({
  createdAt: at,
  createdBy: actor,
  deviceType: 'camera',
  id: 'camera-1',
  location: { id: propertyId, kind: 'property', label: 'Rezidence Parková' },
  name: 'Kamera',
  state: 'in_operation',
  updatedAt: at,
  updatedBy: actor,
});
const collection = {
  properties: {
    dueDate: { locked: true, type: 'DATE' },
    ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
    status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
    title: { locked: true, type: 'TEXT' },
  },
  ref: { moduleId: 'work.tasks', resourceId: 'tasks', resourceType: 'work.tasks.task-collection', tenantId },
  title: 'Tasks',
} as const;
const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: actor,
  assignablePrincipals: [],
  canWrite: true,
  collection,
  indicators: { open: 0, openByAssignee: [], overdue: 0 },
  items: [],
  principalNames: [],
  referenceDate: '2026-10-20',
  revision: 12,
});
const draft = {
  description: 'Prověřit kabeláž',
  dueDate: '2026-10-23',
  severity: 'low',
  title: 'Kontrola kamery',
} as const;
const result = Schema.decodeUnknownSync(ApplyCommandResultSchema)({
  revision: 13,
  task: {
    collectionRef: collection.ref,
    contextRefs: [],
    createdAt: at,
    priority: 'LOW',
    ref: { moduleId: 'work.tasks', resourceId: 'task-1', resourceType: 'work.tasks.task', tenantId },
    state: 'NEW',
    title: draft.title,
    updatedAt: at,
  },
});

const commands: {
  readonly payload: typeof ApplyCommandPayloadSchema.Encoded;
  readonly referenceCredentials: string | undefined;
}[] = [];
let answer: Effect.Effect<
  typeof ApplyCommandResultSchema.Type | typeof ActionProposalAcceptedSchema.Type,
  ApplyCommandActionProblem
> = Effect.succeed(result);
const issuer = shellGatewayIssuer({
  'property-portfolio': '/property-portfolio-api',
  'work-tasks': '/work-tasks-api',
});
const OwnerActionApi = ApplyCommandActionApi.prefix('/work-tasks-api');
const OwnerRecordsApi = RecordsApi.prefix('/work-tasks-api');
const network = browserNetwork(
  issuer.application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.gen(function* applyCommand() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          commands.push({ payload, referenceCredentials: request.headers['x-ontos-reference-credentials'] });
          return yield* answer;
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) => group.handle('execute', () => Effect.succeed(records))),
  ),
);

const propertyCredentials = (index: number) => {
  const issued = Option.getOrThrow(
    Option.fromUndefinedOr(issuer.issued.filter(({ audience }) => audience === 'property-portfolio')[index]),
  );
  return JSON.stringify([{ audience: issued.audience, authorization: `Bearer ${issued.token}` }]);
};

beforeEach(() => {
  commands.length = 0;
  issuer.issued.length = 0;
  answer = Effect.succeed(result);
});

it.live('passes the property owner credential and preserves the structured reference', () =>
  Effect.gen(function* serviceTaskReference() {
    yield* pinTestDocument;
    const created = yield* createServiceTask(draft, { device, tenantId });
    expect(created.status).toBe('created');
    expect(
      issuer.issued.filter(({ audience }) => audience === 'property-portfolio').map(({ audience }) => audience),
    ).toEqual(['property-portfolio']);
    const call = Option.getOrThrow(Option.fromUndefinedOr(commands[0]));
    expect(call.payload.command).toMatchObject({
      contextRefs: [
        {
          moduleId: 'property.portfolio',
          resourceId: propertyId,
          resourceType: 'property.portfolio.property',
          tenantId,
        },
      ],
    });
    expect(call.referenceCredentials).toBe(propertyCredentials(0));
  }).pipe(Effect.provide(network)),
);

it.live('never retries an unavailable owner by dropping contextRefs', () =>
  Effect.gen(function* serviceTaskReference() {
    yield* pinTestDocument;
    const unavailable = Schema.decodeUnknownSync(ApplyCommandActionUnavailableProblemSchema)({
      _tag: 'ApplyCommandActionUnavailableProblem',
      code: 'work_reference_unavailable',
      detail: 'The property owner is unavailable',
      retryable: true,
      status: 503,
      title: 'Service unavailable',
      type: 'urn:ontos:work-reference-unavailable',
    });
    answer = Effect.fail(unavailable);
    expect(yield* createServiceTask(draft, { device, tenantId })).toEqual({ status: 'failed' });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.payload.command).toHaveProperty('contextRefs');
  }).pipe(Effect.provide(network)),
);

it.live('retries only one revision conflict, still carrying the unit link and credential', () =>
  Effect.gen(function* serviceTaskReference() {
    yield* pinTestDocument;
    const conflict = Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
      _tag: 'ApplyCommandActionConflictProblem',
      code: 'work_revision_conflict',
      detail: 'The task revision changed',
      status: 409,
      title: 'Revision conflict',
      type: 'urn:ontos:work-revision-conflict',
    });
    answer = Effect.suspend(() => (commands.length === 1 ? Effect.fail(conflict) : Effect.succeed(result)));
    const unit = {
      ...device,
      location: { id: propertyId, kind: 'unit', label: 'Rezidence Parková' },
    } satisfies typeof device;
    const created = yield* createServiceTask(draft, { device: unit, tenantId });
    expect(created.status).toBe('created');
    expect(commands).toHaveLength(2);
    for (const [index, call] of commands.entries()) {
      expect(call.payload.command).toMatchObject({ contextRefs: [{ resourceType: 'property.portfolio.unit' }] });
      expect(call.referenceCredentials).toBe(propertyCredentials(index));
    }
  }).pipe(Effect.provide(network)),
);

it.live('reports a parked proposal as pending approval without a task and never resubmits it', () =>
  Effect.gen(function* serviceTaskReference() {
    yield* pinTestDocument;
    answer = Effect.succeed(
      Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
        _tag: 'ActionProposalAccepted',
        expiresAt: '2026-10-27T08:00:00Z',
        proposalId: '73000000-0000-4000-8000-000000000022',
      }),
    );
    expect(yield* createServiceTask(draft, { device, tenantId })).toEqual({ status: 'pending_approval' });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.referenceCredentials).toBe(propertyCredentials(0));
  }).pipe(Effect.provide(network)),
);
