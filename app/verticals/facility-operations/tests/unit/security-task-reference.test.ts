import { beforeEach, expect, it, rstest } from '@rstest/core';
import { Effect, Redacted } from 'effect';

rstest.mock('@app/shared-contracts', () => ({ makeReferenceGatewayCredentials: rstest.fn() }));
rstest.mock('@app/work-tasks/clients/apply-command', () => ({ executeApplyCommand: rstest.fn() }));
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: rstest.fn() }));
import { makeReferenceGatewayCredentials } from '@app/shared-contracts';
import { executeApplyCommand } from '@app/work-tasks/clients/apply-command';
import { executeRecords } from '@app/work-tasks/clients/records';
import { createServiceTask } from '../../src/routes/[lang]/provoz/bezpecnost/security-model.ts';
import type { SecurityDevice } from '../../shared/domain/security.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const propertyId = 'f5ef97e9-2935-4ebc-83e6-aa9d475e561b';
const device = { location: { id: propertyId, kind: 'property', label: 'Rezidence Parková' } } as SecurityDevice;
const draft = { description: 'Prověřit kabeláž', dueDate: '2026-10-23', severity: 'low', title: 'Kontrola kamery' } as const;
const credentials = Redacted.make('same-principal-property-credential');

beforeEach(() => {
  rstest.clearAllMocks();
  rstest.mocked(makeReferenceGatewayCredentials).mockReturnValue(Effect.succeed(credentials));
  rstest.mocked(executeRecords).mockReturnValue(Effect.succeed({ revision: 12 } as never));
  rstest.mocked(executeApplyCommand).mockReturnValue(Effect.succeed({ task: {
    ref: { resourceId: 'task-1', tenantId }, title: draft.title,
  } } as never));
});

it('passes the property owner credential and preserves the structured reference', async () => {
  expect((await createServiceTask(draft, device, tenantId)).ok).toBe(true);
  expect(makeReferenceGatewayCredentials).toHaveBeenCalledWith(['property-portfolio']);
  const [payload, , options] = rstest.mocked(executeApplyCommand).mock.calls[0]!;
  expect(payload.command).toMatchObject({ contextRefs: [{ moduleId: 'property.portfolio', resourceId: propertyId,
    resourceType: 'property.portfolio.property', tenantId }] });
  expect(options.referenceCredentials).toBe(credentials);
});

it('never retries an unavailable owner by dropping contextRefs', async () => {
  rstest.mocked(executeApplyCommand).mockReturnValue(Effect.fail({ _tag: 'ApplyCommandActionUnavailableProblem' } as never));
  expect(await createServiceTask(draft, device, tenantId)).toEqual({ ok: false });
  expect(executeApplyCommand).toHaveBeenCalledTimes(1);
  expect(rstest.mocked(executeApplyCommand).mock.calls[0]?.[0].command).toHaveProperty('contextRefs');
});

it('retries only one revision conflict, still carrying the unit link and credential', async () => {
  rstest.mocked(executeApplyCommand).mockReturnValueOnce(Effect.fail({ _tag: 'ApplyCommandActionConflictProblem' } as never));
  const unit = { ...device, location: { ...device.location, kind: 'unit' } } as SecurityDevice;
  expect((await createServiceTask(draft, unit, tenantId)).ok).toBe(true);
  expect(executeApplyCommand).toHaveBeenCalledTimes(2);
  for (const [payload, , options] of rstest.mocked(executeApplyCommand).mock.calls) {
    expect(payload.command).toMatchObject({ contextRefs: [{ resourceType: 'property.portfolio.unit' }] });
    expect(options.referenceCredentials).toBe(credentials);
  }
});
