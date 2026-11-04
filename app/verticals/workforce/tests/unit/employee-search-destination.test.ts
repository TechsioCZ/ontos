import { Deferred, Effect, Fiber, Schema } from 'effect';
import { expect, it, test } from 'effect-rstest';

import { EmployeeIdSchema, EmployeeSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { RecordsPage } from '../../src/routes/[lang]/prodej/zamestnanci/page.tsx';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import {
  EmployeeTargetController,
  employeeTargetRequestKey,
  employeeTargetScopeKey,
  employeeSearchNotice,
  employeeSearchPanelMode,
  employeeSearchSelection,
  employeeSearchTargetFromSearchStr,
  shouldOpenEmployeeSearchTarget,
} from '../../src/routes/[lang]/prodej/zamestnanci/employee-dialogs.tsx';
import type {
  EmployeeTargetRequest,
  EmployeeTargetState,
} from '../../src/routes/[lang]/prodej/zamestnanci/employee-dialogs.tsx';

test('the existing employees page module still exposes its registered page', () => {
  expect(RecordsPage).toBeDefined();
});

const firstId = Schema.decodeUnknownSync(EmployeeIdSchema)('50000000-0000-4000-8000-000000000001');
const secondId = Schema.decodeUnknownSync(EmployeeIdSchema)('50000000-0000-4000-8000-000000000002');
const thirdId = Schema.decodeUnknownSync(EmployeeIdSchema)('50000000-0000-4000-8000-000000000003');

const employee = (id: typeof firstId, fullName: string) =>
  Schema.decodeUnknownSync(EmployeeSchema)({
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    department: 'Obchod',
    email: `${fullName.toLowerCase().replaceAll(' ', '.')}@example.test`,
    fullName,
    id,
    role: 'SALES_REP',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

const first = employee(firstId, 'Jana První');
const second = employee(secondId, 'Petr Druhý');

test('a copied native employee id selects exactly that authorized employee, never the first row', () => {
  const target = employeeSearchTargetFromSearchStr(`?employeeId=${secondId}`);
  expect(target).toEqual({ id: secondId, kind: 'id' });
  const selection = employeeSearchSelection({ items: [first, second], load: 'ready', target });
  expect(selection.status).toBe('ready');
  if (selection.status === 'ready') {
    expect(selection.employee.id).toBe(secondId);
    expect(selection.employee.fullName).toBe('Petr Druhý');
  }
});

test('another query parameter never invents a selection and a duplicate employee id is invalid', () => {
  expect(employeeSearchTargetFromSearchStr('')).toEqual({ kind: 'absent' });
  expect(employeeSearchTargetFromSearchStr('?foo=bar')).toEqual({ kind: 'absent' });
  expect(employeeSearchTargetFromSearchStr('?employeeId=not-an-employee-id')).toEqual({ kind: 'invalid' });
  expect(employeeSearchTargetFromSearchStr(`?employeeId=${firstId}&employeeId=${secondId}`)).toEqual({
    kind: 'invalid',
  });
});

test('an authorized target absent from the current unfiltered read stays missing instead of falling back', () => {
  const target = employeeSearchTargetFromSearchStr(`?employeeId=${thirdId}`);
  expect(employeeSearchSelection({ items: [first, second], load: 'ready', target })).toEqual({
    employeeId: thirdId,
    status: 'missing',
  });
  expect(employeeSearchSelection({ items: [], load: 'forbidden', target })).toEqual({
    employeeId: thirdId,
    status: 'forbidden',
  });
  expect(employeeSearchSelection({ items: [], load: 'error', target })).toEqual({
    employeeId: thirdId,
    status: 'unavailable',
  });
  expect(employeeSearchSelection({ items: [first], load: 'loading', target })).toEqual({
    employeeId: thirdId,
    status: 'loading',
  });
});

test('a company or principal scope change invalidates the previous selection and cannot reuse its record', () => {
  const target = employeeSearchTargetFromSearchStr(`?employeeId=${secondId}`);
  expect(employeeSearchSelection({ items: [first, second], load: 'ready', target }).status).toBe('ready');
  // The next company starts from its own pending read; the previous company's second employee is not reused.
  expect(employeeSearchSelection({ items: [first, second], load: 'loading', target })).toEqual({
    employeeId: secondId,
    status: 'loading',
  });
  expect(employeeSearchSelection({ items: [first], load: 'ready', target })).toEqual({
    employeeId: secondId,
    status: 'missing',
  });
});

test('opening the copied target never replaces or discards a dialog that already holds a draft', () => {
  const selection = employeeSearchSelection({
    items: [first, second],
    load: 'ready',
    target: employeeSearchTargetFromSearchStr(`?employeeId=${secondId}`),
  });
  expect(shouldOpenEmployeeSearchTarget({ activeDialogOpened: false, dismissedEmployeeId: null, selection })).toBe(
    true,
  );
  expect(shouldOpenEmployeeSearchTarget({ activeDialogOpened: true, dismissedEmployeeId: null, selection })).toBe(
    false,
  );
  expect(shouldOpenEmployeeSearchTarget({ activeDialogOpened: false, dismissedEmployeeId: secondId, selection })).toBe(
    false,
  );
  expect(
    shouldOpenEmployeeSearchTarget({
      activeDialogOpened: false,
      dismissedEmployeeId: null,
      selection: { employeeId: thirdId, status: 'missing' },
    }),
  ).toBe(false);
});

test('a reader without write opens the same record read-only with no mutation affordance', () => {
  expect(employeeSearchPanelMode(false)).toBe('read-only');
  expect(employeeSearchPanelMode(true)).toBe('edit');

  const target = employeeSearchTargetFromSearchStr(`?employeeId=${thirdId}`);
  const missing = employeeSearchSelection({ items: [first, second], load: 'ready', target });
  // The unavailable copied target offers only a retry of the read, never a create, edit or delete action.
  expect(employeeSearchNotice(missing)).toEqual({
    labelKey: 'workforce.pages.employees.errors.load',
    retry: true,
    tone: 'warning',
  });
  expect(employeeSearchNotice({ employeeId: thirdId, status: 'forbidden' })).toEqual({
    labelKey: 'workforce.pages.employees.empty.forbidden',
    retry: false,
    tone: 'error',
  });
  expect(
    employeeSearchNotice({
      employee: second,
      employeeId: secondId,
      status: 'ready',
    }),
  ).toBeUndefined();
});

const principalId = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand('PrincipalId')))(
  '30000000-0000-4000-8000-000000000001',
);
const tenantId = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand('TenantId')))(
  '10000000-0000-4000-8000-000000000001',
);
const legalEntityId = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand('LegalEntityId')))(
  '20000000-0000-4000-8000-000000000001',
);
const otherLegalEntityId = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand('LegalEntityId')))(
  '20000000-0000-4000-8000-000000000002',
);
const scope = { legalEntityId, principalId, tenantId };
const rawEmployee = (id: typeof firstId, fullName: string) => ({
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  department: 'Obchod',
  email: `${fullName.toLowerCase().replaceAll(' ', '.')}@example.test`,
  fullName,
  id,
  role: 'SALES_REP' as const,
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const firstRaw = rawEmployee(firstId, 'Jana První');
const secondRaw = rawEmployee(secondId, 'Petr Druhý');
const thirdRaw = rawEmployee(thirdId, 'Třetí Zaměstnanec');

const requestOf = (employeeId: typeof firstId, attempt = 0): EmployeeTargetRequest => ({
  attempt,
  employeeId,
  scope,
});

const recordsWith = (
  items: readonly ReturnType<typeof rawEmployee>[],
  options: {
    readonly actor?: { readonly principalId: string; readonly tenantId: string };
    readonly canWrite?: boolean;
  } = {},
): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    actorPrincipalRef: options.actor ?? { principalId, tenantId },
    availablePrincipals: [{ displayName: 'Petr Druhý', principalRef: { principalId, tenantId } }],
    canWrite: options.canWrite ?? true,
    indicators: {
      active: items.length,
      byDepartment: [{ count: items.length, department: 'Obchod' }],
      byRole: {
        ACCOUNTANT: 0,
        SALES_HEAD: 0,
        SALES_REP: items.length,
        SUPPORT: 0,
        WAREHOUSE: 0,
      },
      total: items.length,
    },
    items,
    revision: 7,
  });

interface Applied {
  readonly request: EmployeeTargetRequest;
  readonly state: EmployeeTargetState;
}

const forbiddenSchema = Schema.Struct({ _tag: Schema.Literal('RecordsForbiddenProblem') });
const classifyFailure = (failure: { readonly _tag: string }): 'forbidden' | 'unavailable' =>
  Schema.is(forbiddenSchema)(failure) ? 'forbidden' : 'unavailable';

/** Captures the controller's effect so the test harness runs it on its own runtime and clock. */
const queuedEffects = () => {
  let queued: Effect.Effect<void> | null = null;
  return {
    run: (effect: Effect.Effect<void>): (() => void) => {
      queued = effect;
      return () => {
        // The controller epoch prevents a superseded effect from publishing; no root fiber is started here.
      };
    },
    take: (): Effect.Effect<void> => {
      if (queued === null) {
        throw new Error('expected a queued target read');
      }
      const effect = queued;
      queued = null;
      return effect;
    },
  };
};

it.effect('the fresh target read publishes exactly the authorized record with its own revision and capabilities', () =>
  Effect.gen(function* freshTargetReady() {
    const deferred = yield* Deferred.make<RecordsResponse>();
    const applied: Applied[] = [];
    const queue = queuedEffects();
    let reads = 0;
    const controller = new EmployeeTargetController<{ readonly _tag: string }>(
      (request, state) => {
        applied.push({ request, state });
      },
      classifyFailure,
      () => {
        reads += 1;
        return Deferred.await(deferred);
      },
      queue.run,
    );
    controller.update({ enabled: true, request: requestOf(secondId) });
    expect(reads).toBe(1);
    expect(applied.at(-1)?.state.status).toBe('loading');
    const fiber = yield* Effect.forkChild(queue.take());
    yield* Deferred.succeed(deferred, recordsWith([firstRaw, secondRaw]));
    yield* Fiber.join(fiber);
    const state = applied.at(-1)?.state;
    expect(state?.status).toBe('ready');
    if (state?.status === 'ready') {
      expect(state.employeeId).toBe(secondId);
      expect(state.record.employee.id).toBe(secondId);
      expect(state.record.revision).toBe(7);
      expect(state.record.canWrite).toBe(true);
      expect(state.record.availablePrincipals).toHaveLength(1);
    }
  }),
);

it.effect('a target or scope change cancels the old response so it can never open a panel', () =>
  Effect.gen(function* staleTargetResponse() {
    const firstRead = yield* Deferred.make<RecordsResponse>();
    const secondRead = yield* Deferred.make<RecordsResponse>();
    const applied: Applied[] = [];
    const queue = queuedEffects();
    let reads = 0;
    const controller = new EmployeeTargetController<{ readonly _tag: string }>(
      (request, state) => {
        applied.push({ request, state });
      },
      classifyFailure,
      (employeeId) => {
        reads += 1;
        return Deferred.await(employeeId === secondId ? firstRead : secondRead);
      },
      queue.run,
    );
    controller.update({ enabled: true, request: requestOf(secondId) });
    const stale = queue.take();
    controller.update({ enabled: true, request: requestOf(thirdId) });
    const current = queue.take();
    expect(reads).toBe(2);

    const staleFiber = yield* Effect.forkChild(stale);
    yield* Deferred.succeed(firstRead, recordsWith([secondRaw]));
    yield* Fiber.join(staleFiber);
    expect(applied.some(({ state }) => state.status === 'ready')).toBe(false);

    const currentFiber = yield* Effect.forkChild(current);
    yield* Deferred.succeed(secondRead, recordsWith([thirdRaw]));
    yield* Fiber.join(currentFiber);
    const ready = applied.at(-1)?.state;
    expect(ready?.status).toBe('ready');
    if (ready?.status === 'ready') {
      expect(ready.employeeId).toBe(thirdId);
    }
  }),
);

it.effect('a disabled lookup (no free dialog/draft ownership) never reads or replaces an active panel', () =>
  Effect.gen(function* disabledLookup() {
    let reads = 0;
    const applied: Applied[] = [];
    const queue = queuedEffects();
    const controller = new EmployeeTargetController<{ readonly _tag: string }>(
      (request, state) => {
        applied.push({ request, state });
      },
      classifyFailure,
      () => {
        reads += 1;
        return Effect.succeed(recordsWith([secondRaw]));
      },
      queue.run,
    );
    controller.update({ enabled: false, request: requestOf(secondId) });
    expect(reads).toBe(0);
    expect(applied).toHaveLength(0);

    controller.update({ enabled: true, request: requestOf(secondId) });
    expect(reads).toBe(1);
    yield* queue.take();
    expect(applied.at(-1)?.state.status).toBe('ready');
  }),
);

it.effect('only a current-actor exact record is ready; another actor or an absent item is truthful', () =>
  Effect.gen(function* truthfulFailures() {
    const applied: Applied[] = [];
    const queue = queuedEffects();
    const controller = new EmployeeTargetController<{ readonly _tag: string }>(
      (request, state) => {
        applied.push({ request, state });
      },
      classifyFailure,
      (employeeId) => {
        if (employeeId === firstId) {
          return Effect.fail({ _tag: 'RecordsForbiddenProblem' });
        }
        if (employeeId === secondId) {
          return Effect.succeed(
            recordsWith([secondRaw], { actor: { principalId: '30000000-0000-4000-8000-000000000002', tenantId } }),
          );
        }
        return Effect.succeed(recordsWith([]));
      },
      queue.run,
    );
    controller.update({ enabled: true, request: requestOf(firstId) });
    yield* queue.take();
    expect(applied.at(-1)?.state).toMatchObject({ employeeId: firstId, status: 'forbidden' });

    controller.update({ enabled: true, request: requestOf(secondId) });
    yield* queue.take();
    expect(applied.at(-1)?.state).toMatchObject({ employeeId: secondId, status: 'unavailable' });

    controller.update({ enabled: true, request: requestOf(thirdId) });
    yield* queue.take();
    expect(applied.at(-1)?.state).toMatchObject({ employeeId: thirdId, status: 'missing' });
  }),
);

it.effect('the fresh response carries read-only capability for a reader without write', () =>
  Effect.gen(function* readerRecord() {
    const applied: Applied[] = [];
    const queue = queuedEffects();
    const controller = new EmployeeTargetController<{ readonly _tag: string }>(
      (request, state) => {
        applied.push({ request, state });
      },
      classifyFailure,
      () => Effect.succeed(recordsWith([secondRaw], { canWrite: false })),
      queue.run,
    );
    controller.update({ enabled: true, request: requestOf(secondId) });
    yield* queue.take();
    const state = applied.at(-1)?.state;
    expect(state?.status).toBe('ready');
    if (state?.status === 'ready') {
      expect(state.record.canWrite).toBe(false);
      expect(state.record.revision).toBe(7);
    }
  }),
);

test('request identity covers tenant, company, principal and employee, so only the exact target reuses a result', () => {
  const otherScope = { ...scope, legalEntityId: otherLegalEntityId };
  expect(employeeTargetRequestKey(requestOf(secondId))).not.toBe(employeeTargetRequestKey(requestOf(thirdId)));
  expect(employeeTargetRequestKey(requestOf(secondId))).not.toBe(
    employeeTargetRequestKey({ employeeId: secondId, scope: otherScope }),
  );
  expect(employeeTargetScopeKey(scope)).not.toBe(employeeTargetScopeKey(otherScope));
});
