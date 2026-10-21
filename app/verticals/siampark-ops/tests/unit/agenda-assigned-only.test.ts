import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { AgendaStateSchema, PERSONAL_AGENDA_COMMANDS, agendaStateForAssignee } from '../../shared/domain/agenda.ts';
import { meterAccess } from '../../shared/domain/meters-access.ts';
import { isAssignedOnly } from '../../src/services/persistence.service.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const external = { principalId: '72000000-0000-4000-8000-000000000024', tenantId };
const operations = { principalId: '72000000-0000-4000-8000-000000000022', tenantId };
const event = (id: string, assignee?: typeof external) => ({
  createdAt: '2026-10-19T07:30:00.000Z',
  createdBy: operations,
  updatedAt: '2026-10-19T07:30:00.000Z',
  updatedBy: operations,
  id,
  title: `Událost ${id}`,
  date: '2026-10-22',
  kind: 'MEETING',
  status: 'PLANNED',
  ...(assignee === undefined ? {} : { assignee, assigneeLabel: 'x' }),
});

it('returns only the events assigned to an operational-only principal', () => {
  const state = Schema.decodeUnknownSync(AgendaStateSchema)({
    events: [
      event('73130000-0000-4000-8000-000000000901', operations),
      event('73130000-0000-4000-8000-000000000902', external),
      event('73130000-0000-4000-8000-000000000903'),
    ],
  });
  expect(agendaStateForAssignee(state, external).events.map((entry) => entry.id)).toEqual([
    '73130000-0000-4000-8000-000000000902',
  ]);
});

it('treats the external partner grants as assigned-only and read-only for meters', () => {
  const externalGrants = { readAll: false, readOperational: true, writeAll: false, writeOperational: false };
  expect(isAssignedOnly(externalGrants)).toBe(true);
  expect(isAssignedOnly({ ...externalGrants, readAll: true })).toBe(false);
  expect(meterAccess(externalGrants)).toEqual({ canRead: true, canWrite: false, canReadFinancial: false, canManage: false });
  expect(PERSONAL_AGENDA_COMMANDS.has('AgendaEventCreate')).toBe(false);
  expect(PERSONAL_AGENDA_COMMANDS.has('AgendaEventUpdate')).toBe(false);
  expect(PERSONAL_AGENDA_COMMANDS.has('AgendaNotificationsMarkRead')).toBe(true);
});
