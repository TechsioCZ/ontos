import { ContractSchema } from '@app/siampark-agreements/contracts/records';
import { OccupancySchema } from '@app/siampark-occupancy/contracts/records';
import { TaskSchema } from '@app/siampark-work/contracts/records';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { projectOverviewAgenda } from '../../src/routes/[lang]/siampark/overview/page.tsx';

const ref = (owner: string, resource: string, index: number) => ({
  moduleId: owner,
  resourceId: `76000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  resourceType: `${owner}.${resource}`,
  tenantId: '70000000-0000-4000-8000-000000000020',
});
const SourceSchema = Schema.Struct({
  agreements: Schema.Struct({
    contracts: Schema.Array(
      Schema.Struct({
        contractRef: ContractSchema.fields.contractRef,
        endDate: ContractSchema.fields.endDate,
        lifecycleState: ContractSchema.fields.lifecycleState,
      }),
    ),
  }),
  occupancy: Schema.Struct({
    occupancies: Schema.Array(
      Schema.Struct({
        endDate: OccupancySchema.fields.endDate,
        occupancyRef: OccupancySchema.fields.occupancyRef,
        startDate: OccupancySchema.fields.startDate,
        state: OccupancySchema.fields.state,
        unitRef: OccupancySchema.fields.unitRef,
      }),
    ),
  }),
  work: Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        dueDate: TaskSchema.fields.dueDate,
        ref: TaskSchema.fields.ref,
        state: TaskSchema.fields.state,
        title: TaskSchema.fields.title,
      }),
    ),
  }),
});
const activeContract = {
  contractRef: ref('siampark.agreements', 'contract', 1),
  endDate: '2026-10-15',
  lifecycleState: 'ACTIVE',
};
const activeOccupancy = {
  endDate: '2026-10-10',
  occupancyRef: ref('siampark.occupancy', 'occupancy', 2),
  startDate: '2026-10-05',
  state: 'CONFIRMED',
  unitRef: ref('siampark.property', 'unit', 3),
};
const task = { dueDate: '2026-10-04', ref: ref('siampark.work', 'task', 4), state: 'NEW', title: 'Prepare renewal' };

it.effect('combines all three public owners into a date-sorted agenda preserving owning resource links', () =>
  Effect.gen(function* agendaAcrossOwners() {
    const records = yield* Schema.decodeUnknownEffect(SourceSchema)({
      agreements: { contracts: [activeContract] },
      occupancy: { occupancies: [activeOccupancy] },
      work: { items: [task] },
    });
    const agenda = projectOverviewAgenda(records);
    expect(agenda.map((entry) => [entry.date, entry.kind, entry.owner, entry.resourceId])).toEqual([
      ['2026-10-04', 'task', 'work', task.ref.resourceId],
      ['2026-10-05', 'occupancyStart', 'occupancy', activeOccupancy.occupancyRef.resourceId],
      ['2026-10-10', 'occupancyEnd', 'occupancy', activeOccupancy.occupancyRef.resourceId],
      ['2026-10-15', 'contract', 'agreements', activeContract.contractRef.resourceId],
    ]);
    expect(records.work.items[0]?.state).toBe('NEW');
    expect(records.occupancy.occupancies[0]?.state).toBe('CONFIRMED');
  }),
);

it.effect('reflects owner changes, excludes cancelled/terminal records and has no invented open-ended end date', () =>
  Effect.gen(function* derivesChangesWithoutCalendarState() {
    const records = yield* Schema.decodeUnknownEffect(SourceSchema)({
      agreements: {
        contracts: [
          { ...activeContract, lifecycleState: 'TERMINATED' },
          { ...activeContract, endDate: null },
        ],
      },
      occupancy: {
        occupancies: [
          { ...activeOccupancy, state: 'CANCELLED' },
          { ...activeOccupancy, endDate: null, state: 'ACTIVE' },
        ],
      },
      work: {
        items: [
          { ...task, state: 'DONE' },
          { ...task, dueDate: '2026-10-06', ref: ref('siampark.work', 'task', 5), state: 'WAITING' },
        ],
      },
    });
    expect(projectOverviewAgenda(records).map((entry) => [entry.date, entry.kind])).toEqual([
      ['2026-10-05', 'occupancyStart'],
      ['2026-10-06', 'task'],
    ]);
  }),
);
