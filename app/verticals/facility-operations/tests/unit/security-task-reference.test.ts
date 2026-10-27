import { beforeEach, expect, it, rstest } from 'effect-rstest';
import { Effect, Redacted, Schema } from 'effect';
import { ApplyCommandResultSchema } from '@app/work-tasks/contracts/apply-command';
import { RecordsResponseSchema } from '@app/work-tasks/contracts/records';

import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { executeApplyCommand } from '@app/work-tasks/clients/apply-command';
import { executeRecords } from '@app/work-tasks/clients/records';
import { createServiceTask } from '../../src/routes/[lang]/provoz/bezpecnost/security-model.ts';
import { SecurityDeviceSchema } from '../../shared/domain/security.ts';

rstest.mock('@app/shared-contracts', () => {
  const actual = rstest.requireActual<{
    readonly makeReferenceGatewayCredentials: typeof makeReferenceGatewayCredentials;
  }>('@app/shared-contracts');
  return { ...actual, makeReferenceGatewayCredentials: rstest.fn(actual.makeReferenceGatewayCredentials) };
});
rstest.mock('@app/work-tasks/clients/apply-command', () => ({ executeApplyCommand: rstest.fn() }));
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: rstest.fn() }));

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
const credentials = Redacted.make('same-principal-property-credential');

beforeEach(() => {
  rstest.clearAllMocks();
  rstest.mocked(makeReferenceGatewayCredentials).mockReturnValue(Effect.succeed(credentials));
  rstest.mocked(executeRecords).mockReturnValue(Effect.succeed(records));
  rstest.mocked(executeApplyCommand).mockReturnValue(
    Effect.succeed(
      Schema.decodeUnknownSync(ApplyCommandResultSchema)({
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
      }),
    ),
  );
});

it.effect('passes the property owner credential and preserves the structured reference', () =>
  Effect.gen(function* serviceTaskReference() {
    const created = yield* createServiceTask(draft, device, tenantId);
    expect(created.ok).toBe(true);
    expect(makeReferenceGatewayCredentials).toHaveBeenCalledWith(['property-portfolio']);
    const [call] = rstest.mocked(executeApplyCommand).mock.calls;
    if (call === undefined) {
      throw new Error('Missing task command invocation');
    }
    const [payload, , options] = call;
    expect(payload.command).toMatchObject({
      contextRefs: [
        {
          moduleId: 'property.portfolio',
          resourceId: propertyId,
          resourceType: 'property.portfolio.property',
          tenantId,
        },
      ],
    });
    expect(options.referenceCredentials).toBe(credentials);
  }),
);

it.effect('never retries an unavailable owner by dropping contextRefs', () =>
  Effect.gen(function* serviceTaskReference() {
    const unavailable = {
      _tag: 'ApplyCommandActionUnavailableProblem',
      code: 'work_reference_unavailable',
      detail: 'The property owner is unavailable',
      retryable: true,
      status: 503,
      title: 'Service unavailable',
      type: 'urn:ontos:work-reference-unavailable',
    } satisfies Extract<
      Effect.Error<ReturnType<typeof executeApplyCommand>>,
      { readonly _tag: 'ApplyCommandActionUnavailableProblem' }
    >;
    rstest.mocked(executeApplyCommand).mockReturnValue(Effect.fail(unavailable));
    expect(yield* createServiceTask(draft, device, tenantId)).toEqual({ ok: false });
    expect(executeApplyCommand).toHaveBeenCalledTimes(1);
    expect(rstest.mocked(executeApplyCommand).mock.calls[0]?.[0].command).toHaveProperty('contextRefs');
  }),
);

it.effect('retries only one revision conflict, still carrying the unit link and credential', () =>
  Effect.gen(function* serviceTaskReference() {
    const conflict = {
      _tag: 'ApplyCommandActionConflictProblem',
      code: 'work_revision_conflict',
      detail: 'The task revision changed',
      status: 409,
      title: 'Revision conflict',
      type: 'urn:ontos:work-revision-conflict',
    } satisfies Extract<
      Effect.Error<ReturnType<typeof executeApplyCommand>>,
      { readonly _tag: 'ApplyCommandActionConflictProblem' }
    >;
    rstest.mocked(executeApplyCommand).mockReturnValueOnce(Effect.fail(conflict));
    const unit = {
      ...device,
      location: { id: propertyId, kind: 'unit', label: 'Rezidence Parková' },
    } satisfies typeof device;
    const created = yield* createServiceTask(draft, unit, tenantId);
    expect(created.ok).toBe(true);
    expect(executeApplyCommand).toHaveBeenCalledTimes(2);
    for (const [payload, , options] of rstest.mocked(executeApplyCommand).mock.calls) {
      expect(payload.command).toMatchObject({ contextRefs: [{ resourceType: 'property.portfolio.unit' }] });
      expect(options.referenceCredentials).toBe(credentials);
    }
  }),
);
