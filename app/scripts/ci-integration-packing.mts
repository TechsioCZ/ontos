import costTable from './ci-integration-costs.json' with { type: 'json' };
import type { IntegrationEntry } from './plan-ci-checks.mts';

export const integrationTaskSeconds: Readonly<Record<string, number>> = costTable.seconds;
export interface IntegrationPackingInvalid {
  readonly invalid: string;
}

// Keep in sync with run-integration-suites.sh: these run serially before either lane is admitted.
export const exclusiveIntegrationTasks = [
  'whole:pricing',
  './verticals/commerce-market-catalog#1/4',
  './verticals/party-registry#4/4',
];

// Native topology proofs must never share a runner, even if their measured costs would fit.
export const nativeIntegrationProofs = [
  'whole:organization',
  'whole:privacy',
  'whole:pricing',
  'whole:preproposal-basis',
  'whole:preproposal-approval',
];

interface MeasuredTask {
  readonly id: string;
  readonly seconds: number;
}
interface PackingRow {
  readonly entry: IntegrationEntry;
  readonly tasks: MeasuredTask[];
  total: number;
}

interface PackingChoice {
  readonly available: number;
  readonly row: PackingRow;
  readonly seconds: number;
}
const choicePriority = (left: PackingChoice, right: PackingChoice) =>
  left.available - right.available || left.seconds - right.seconds || left.row.total - right.row.total;
const taskPriority = (left: MeasuredTask, right: MeasuredTask) =>
  Number(exclusiveIntegrationTasks.includes(right.id)) - Number(exclusiveIntegrationTasks.includes(left.id)) ||
  right.seconds - left.seconds ||
  (left.id < right.id ? -1 : Number(left.id > right.id));

const measureTasks = (
  tasks: readonly string[],
  costs: Readonly<Record<string, number>>,
): MeasuredTask[] | IntegrationPackingInvalid => {
  const measured: MeasuredTask[] = [];
  for (const id of tasks) {
    const seconds = costs[id];
    if (seconds === undefined || !Number.isSafeInteger(seconds) || seconds <= 0) {
      return { invalid: `Missing or invalid integration cost for ${id}; refresh scripts/ci-integration-costs.json` };
    }
    measured.push({ id, seconds });
  }
  return measured;
};

const rowLoad = (tasks: readonly MeasuredTask[]) => {
  let exclusive = 0;
  const lanes: [number, number] = [0, 0];
  for (const { id, seconds } of tasks) {
    if (exclusiveIntegrationTasks.includes(id)) {
      exclusive += seconds;
    } else {
      const lane = lanes[0] <= lanes[1] ? 0 : 1;
      lanes[lane] += seconds;
    }
  }
  return { available: exclusive + Math.min(...lanes), seconds: exclusive + Math.max(...lanes) };
};

/** Simulate xargs' next-free-lane admission in task order, after the serial exclusive prefix. */
export const integrationRowSeconds = (
  tasks: readonly string[],
  costs: Readonly<Record<string, number>> = integrationTaskSeconds,
) => {
  const measured = measureTasks(tasks, costs);
  return 'invalid' in measured ? measured : { seconds: rowLoad(measured).seconds };
};

/**
 * Authored rows own the task inventory, row count and proof dependencies, not placement. Reserve serial
 * work first, then place longest tasks first on the earliest free lane across the eligible rows.
 * Ties use projected row finish, total work, then row index; task ties use codepoint order, not locale.
 * Considering the free lane (not just max(lanes)) avoids piling short tasks beside a single heavy task.
 * Pack before affected selection: narrowing only removes tasks, preserving the measured queue order,
 * proof metadata and runner isolation without creating extra rows or reintroducing unaffected work.
 * Failures are data so the dependency-free planner needs no Effect runtime; its CLI edges reject them.
 */
export const packIntegrationRows = (
  entries: readonly IntegrationEntry[],
  costs: Readonly<Record<string, number>> = integrationTaskSeconds,
): readonly IntegrationEntry[] | IntegrationPackingInvalid => {
  const owners = entries.filter(({ suite }) => suite === 'integration');
  const tasks = owners.flatMap((row) => row.tasks ?? []);
  if (new Set(tasks).size !== tasks.length) {
    return { invalid: 'Integration task inventory contains duplicates' };
  }
  const measured = measureTasks(tasks, costs);
  if ('invalid' in measured) {
    return measured;
  }
  let pending = measured;
  const rows: PackingRow[] = owners.map((entry) => ({ entry, tasks: [], total: 0 }));
  while (pending.length > 0) {
    const [first, ...rest] = pending;
    if (first === undefined) {
      return { invalid: 'Integration packing lost a pending task' };
    }
    let task = first;
    for (const candidate of rest) {
      if (taskPriority(candidate, task) < 0) {
        task = candidate;
      }
    }
    pending = pending.filter((candidate) => candidate !== task);
    let selected: PackingChoice | undefined;
    for (const row of rows) {
      if (
        nativeIntegrationProofs.includes(task.id) &&
        row.tasks.some((present) => nativeIntegrationProofs.includes(present.id))
      ) {
        continue;
      }
      const choice = { available: rowLoad(row.tasks).available, row, seconds: rowLoad([...row.tasks, task]).seconds };
      if (selected === undefined || choicePriority(choice, selected) < 0) {
        selected = choice;
      }
    }
    if (selected === undefined) {
      return { invalid: `No isolated integration row available for ${task.id}` };
    }
    selected.row.tasks.push(task);
    selected.row.total += task.seconds;
  }
  const packed: IntegrationEntry[] = [];
  let index = 0;
  for (const entry of entries) {
    if (entry.suite !== 'integration') {
      packed.push(entry);
      continue;
    }
    const row = rows[index];
    index += 1;
    if (row === undefined) {
      return { invalid: 'Integration packing lost an owner row' };
    }
    const { 'proof-packages': _proofPackages, ...metadata } = row.entry;
    const proofPackages = [
      ...new Set(
        owners.flatMap((owner) =>
          row.tasks.some((task) => task.id.startsWith('whole:preproposal-') && owner.tasks?.includes(task.id) === true)
            ? (owner['proof-packages'] ?? [])
            : [],
        ),
      ),
    ];
    const result = { ...metadata, lanes: 2, tasks: row.tasks.map(({ id }) => id) } satisfies IntegrationEntry;
    packed.push(proofPackages.length > 0 ? { ...result, 'proof-packages': proofPackages } : result);
  }
  return packed;
};
