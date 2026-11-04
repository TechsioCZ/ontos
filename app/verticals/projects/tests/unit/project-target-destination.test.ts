import { Deferred, Effect, Fiber, Schema } from 'effect';
import { expect, it, test } from 'effect-rstest';

import {
  ReadProjectAuthenticationProblemSchema,
  ReadProjectForbiddenProblemSchema,
  ReadProjectNotFoundProblemSchema,
  ReadProjectUnavailableProblemSchema,
} from '../../shared/apis/read-project.ts';
import { ProjectSchema, ProjectUuidSchema } from '../../shared/domain/project.ts';
import type { Project } from '../../shared/domain/project.ts';
import CreateProjectPage, {
  ProjectTargetController,
  projectInvalidNotice,
  projectPageMode,
  projectScopeNotice,
  projectSearchTargetFromSearchStr,
  projectTargetFailureStatus,
  projectTargetNotice,
  projectTargetRequestKey,
  projectTargetScopeKey,
  projectTargetScopeOf,
  projectTargetStateOf,
} from '../../src/routes/[lang]/projects/create-project/page.tsx';
import type {
  ProjectTargetFailure,
  ProjectTargetRequest,
  ProjectTargetScope,
  ProjectTargetState,
} from '../../src/routes/[lang]/projects/create-project/page.tsx';

test('the existing projects page still exposes its registered page', () => {
  expect(CreateProjectPage).toBeDefined();
});

const projectId = Schema.decodeUnknownSync(ProjectUuidSchema)('30000000-0000-4000-8000-000000000001');
const otherProjectId = Schema.decodeUnknownSync(ProjectUuidSchema)('30000000-0000-4000-8000-000000000002');
const thirdProjectId = Schema.decodeUnknownSync(ProjectUuidSchema)('30000000-0000-4000-8000-000000000003');
const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';
const principalId = '20000000-0000-4000-8000-000000000001';
const otherPrincipalId = '20000000-0000-4000-8000-000000000009';
const legalEntityId = '40000000-0000-4000-8000-000000000001';
const otherLegalEntityId = '40000000-0000-4000-8000-000000000002';
const scope: ProjectTargetScope = { kind: 'company', legalEntityId, principalId, tenantId };
const tenantScope: ProjectTargetScope = { kind: 'tenant', principalId, tenantId };

const project: Project = Schema.decodeUnknownSync(ProjectSchema)({
  createdAt: '2026-09-03T12:00:00.000Z',
  createdByPrincipalId: '20000000-0000-4000-8000-000000000002',
  lifecycleState: 'active',
  name: 'Project',
  ownerPrincipalId: '20000000-0000-4000-8000-000000000003',
  parentProjectId: null,
  prefix: 'ONTO',
  projectId,
  shortText: 'Original',
  tenantId,
});

const requestOf = (
  id: Project['projectId'] = projectId,
  requestScope: ProjectTargetScope = scope,
): ProjectTargetRequest => ({
  projectId: id,
  scope: requestScope,
});

test('a copied native project id selects exactly that target, never the create form', () => {
  const target = projectSearchTargetFromSearchStr(`?projectId=${projectId}`);
  expect(target).toEqual({ kind: 'id', projectId });
  expect(projectPageMode(target)).toBe('target');
  expect(projectPageMode(projectSearchTargetFromSearchStr(''))).toBe('create');
  expect(projectPageMode(projectSearchTargetFromSearchStr('?projectId=not-a-project-id'))).toBe('target');
});

test('another query parameter never invents a target and a duplicate project id is invalid', () => {
  expect(projectSearchTargetFromSearchStr('')).toEqual({ kind: 'absent' });
  expect(projectSearchTargetFromSearchStr('?foo=bar')).toEqual({ kind: 'absent' });
  expect(projectSearchTargetFromSearchStr('?projectId=not-a-project-id')).toEqual({ kind: 'invalid' });
  expect(projectSearchTargetFromSearchStr(`?projectId=${projectId}&projectId=${otherProjectId}`)).toEqual({
    kind: 'invalid',
  });
  // Invalid and duplicated selections are explicit target failures, never a silent fallback to create.
  expect(projectPageMode(projectSearchTargetFromSearchStr('?projectId=not-a-project-id'))).toBe('target');
  expect(projectPageMode(projectSearchTargetFromSearchStr(`?projectId=${projectId}&projectId=${otherProjectId}`))).toBe(
    'target',
  );
});

test('a verified tenant-only context is enough; a missing or company-less company context never is', () => {
  const companyContext = { legalEntityId, principalId, tenantId };
  const tenantContext = { principalId, tenantId };
  expect(projectTargetScopeOf({ context: companyContext, tenantContext })).toEqual(scope);
  expect(projectTargetScopeOf({ tenantContext })).toEqual(tenantScope);
  expect(projectTargetScopeOf({})).toBeUndefined();
  expect(projectTargetScopeOf({ tenantContext: { principalId: '', tenantId } })).toBeUndefined();
  expect(projectTargetScopeOf({ tenantContext: { principalId, tenantId: '' } })).toBeUndefined();
  // A company page control: a tenant-only context never becomes a company scope or invents a company id.
  expect(projectTargetScopeOf({ tenantContext })).not.toHaveProperty('legalEntityId');
});

test('the exact response is ready only for the requested Project in the current tenant', () => {
  expect(projectTargetStateOf(project, requestOf())).toEqual({ project, projectId, status: 'ready' });
  expect(projectTargetStateOf({ ...project, tenantId: otherTenantId }, requestOf())).toEqual({
    projectId,
    status: 'unavailable',
  });
  expect(projectTargetStateOf({ ...project, projectId: otherProjectId }, requestOf())).toEqual({
    projectId,
    status: 'unavailable',
  });
  expect(projectTargetStateOf(project, requestOf(projectId, tenantScope))).toEqual({
    project,
    projectId,
    status: 'ready',
  });
  expect(projectTargetStateOf({ ...project, tenantId: otherTenantId }, requestOf(projectId, tenantScope))).toEqual({
    projectId,
    status: 'unavailable',
  });
  expect(projectTargetStateOf({ ...project, lifecycleState: 'archived' }, requestOf())).toMatchObject({
    project: { lifecycleState: 'archived' },
    projectId,
    status: 'ready',
  });
});

test('request identity covers tenant, company, principal and Project, so only the exact target reuses a result', () => {
  const otherCompany: ProjectTargetScope = {
    kind: 'company',
    legalEntityId: otherLegalEntityId,
    principalId,
    tenantId,
  };
  const otherTenant: ProjectTargetScope = { kind: 'company', legalEntityId, principalId, tenantId: otherTenantId };
  const otherPrincipal: ProjectTargetScope = {
    kind: 'company',
    legalEntityId,
    principalId: otherPrincipalId,
    tenantId,
  };
  expect(projectTargetRequestKey(requestOf())).not.toBe(projectTargetRequestKey(requestOf(otherProjectId)));
  expect(projectTargetRequestKey(requestOf())).not.toBe(projectTargetRequestKey(requestOf(projectId, otherCompany)));
  expect(projectTargetScopeKey(scope)).not.toBe(projectTargetScopeKey(otherCompany));
  expect(projectTargetScopeKey(scope)).not.toBe(projectTargetScopeKey(otherTenant));
  expect(projectTargetScopeKey(scope)).not.toBe(projectTargetScopeKey(otherPrincipal));

  const otherTenantOnly: ProjectTargetScope = { kind: 'tenant', principalId, tenantId: otherTenantId };
  const otherTenantOnlyPrincipal: ProjectTargetScope = { kind: 'tenant', principalId: otherPrincipalId, tenantId };
  expect(projectTargetRequestKey(requestOf(projectId, tenantScope))).not.toBe(
    projectTargetRequestKey(requestOf(otherProjectId, tenantScope)),
  );
  expect(projectTargetRequestKey(requestOf(projectId, tenantScope))).not.toBe(
    projectTargetRequestKey(requestOf(projectId, otherTenantOnly)),
  );
  expect(projectTargetRequestKey(requestOf(projectId, tenantScope))).not.toBe(
    projectTargetRequestKey(requestOf(projectId, otherTenantOnlyPrincipal)),
  );
  expect(projectTargetScopeKey(tenantScope)).not.toBe(projectTargetScopeKey(otherTenantOnly));
  expect(projectTargetScopeKey(tenantScope)).not.toBe(projectTargetScopeKey(otherTenantOnlyPrincipal));
  expect(projectTargetScopeKey(tenantScope)).not.toBe(projectTargetScopeKey(scope));
});

test('the notices stay non-disclosing and never offer a retry the read cannot honor', () => {
  expect(projectTargetNotice({ projectId, status: 'loading' })).toBeUndefined();
  expect(projectTargetNotice({ project, projectId, status: 'ready' })).toBeUndefined();
  expect(projectTargetNotice({ projectId, status: 'forbidden' })).toEqual({
    labelKey: 'projects.pages.projectDetail.forbidden',
    retry: false,
    tone: 'error',
  });
  expect(projectTargetNotice({ projectId, status: 'missing' })).toEqual({
    labelKey: 'projects.pages.projectDetail.missing',
    retry: true,
    tone: 'warning',
  });
  expect(projectTargetNotice({ projectId, status: 'unavailable' })).toEqual({
    labelKey: 'projects.pages.projectDetail.unavailable',
    retry: true,
    tone: 'warning',
  });
  expect(projectInvalidNotice.labelKey).toBe('projects.pages.projectDetail.invalid');
  expect(projectScopeNotice.labelKey).toBe('projects.pages.projectDetail.scopeUnavailable');
});

test('only a denied, missing or unavailable read becomes a notice status', () => {
  const forbidden = Schema.decodeUnknownSync(ReadProjectForbiddenProblemSchema)({
    _tag: 'ReadProjectForbiddenProblem',
    detail: 'Denied',
    status: 403,
    title: 'Forbidden',
    type: 'about:blank',
  });
  const authentication = Schema.decodeUnknownSync(ReadProjectAuthenticationProblemSchema)({
    _tag: 'ReadProjectAuthenticationProblem',
    detail: 'Sign in',
    status: 401,
    title: 'Authentication required',
    type: 'about:blank',
  });
  const notFound = Schema.decodeUnknownSync(ReadProjectNotFoundProblemSchema)({
    _tag: 'ReadProjectNotFoundProblem',
    detail: 'Not found',
    status: 404,
    title: 'Not found',
    type: 'about:blank',
  });
  const unavailable = Schema.decodeUnknownSync(ReadProjectUnavailableProblemSchema)({
    _tag: 'ReadProjectUnavailableProblem',
    detail: 'Unavailable',
    retryable: true,
    status: 503,
    title: 'Unavailable',
    type: 'about:blank',
  });
  expect(projectTargetFailureStatus(forbidden)).toBe('forbidden');
  expect(projectTargetFailureStatus(authentication)).toBe('forbidden');
  expect(projectTargetFailureStatus(notFound)).toBe('missing');
  expect(projectTargetFailureStatus(unavailable)).toBe('unavailable');
});

interface Applied {
  readonly request: ProjectTargetRequest;
  readonly state: ProjectTargetState;
}

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

it.effect('the fresh target read publishes exactly the authorized record', () =>
  Effect.gen(function* freshTargetReady() {
    const deferred = yield* Deferred.make<Project>();
    const applied: Applied[] = [];
    const queue = queuedEffects();
    let reads = 0;
    const controller = new ProjectTargetController<ProjectTargetFailure>(
      (request, state) => {
        applied.push({ request, state });
      },
      projectTargetFailureStatus,
      () => {
        reads += 1;
        return Deferred.await(deferred);
      },
      queue.run,
    );
    controller.update({ enabled: true, request: requestOf() });
    expect(reads).toBe(1);
    expect(applied.at(-1)?.state.status).toBe('loading');
    const fiber = yield* Effect.forkChild(queue.take());
    yield* Deferred.succeed(deferred, project);
    yield* Fiber.join(fiber);
    const state = applied.at(-1)?.state;
    expect(state?.status).toBe('ready');
    if (state?.status === 'ready') {
      expect(state.project.projectId).toBe(projectId);
      expect(state.project.tenantId).toBe(tenantId);
      expect(state.project.name).toBe('Project');
      expect(state.project.ownerPrincipalId).toBe(project.ownerPrincipalId);
    }
  }),
);

it.effect('a target or scope change cancels the old response so it can never publish', () =>
  Effect.gen(function* staleTargetResponse() {
    const firstRead = yield* Deferred.make<Project>();
    const secondRead = yield* Deferred.make<Project>();
    const applied: Applied[] = [];
    const queue = queuedEffects();
    let reads = 0;
    const controller = new ProjectTargetController<ProjectTargetFailure>(
      (request, state) => {
        applied.push({ request, state });
      },
      projectTargetFailureStatus,
      (id) => {
        reads += 1;
        return Deferred.await(id === projectId ? firstRead : secondRead);
      },
      queue.run,
    );
    controller.update({ enabled: true, request: requestOf() });
    const stale = queue.take();
    controller.update({ enabled: true, request: requestOf(otherProjectId) });
    const current = queue.take();
    expect(reads).toBe(2);

    const staleFiber = yield* Effect.forkChild(stale);
    yield* Deferred.succeed(firstRead, project);
    yield* Fiber.join(staleFiber);
    expect(applied.some(({ state }) => state.status === 'ready')).toBe(false);

    const currentFiber = yield* Effect.forkChild(current);
    yield* Deferred.succeed(secondRead, { ...project, projectId: otherProjectId });
    yield* Fiber.join(currentFiber);
    const ready = applied.at(-1)?.state;
    expect(ready?.status).toBe('ready');
    if (ready?.status === 'ready') {
      expect(ready.projectId).toBe(otherProjectId);
    }
  }),
);

it.effect('a company/principal scope change cancels the previous tenant response', () =>
  Effect.gen(function* staleScopeResponse() {
    const firstRead = yield* Deferred.make<Project>();
    const secondRead = yield* Deferred.make<Project>();
    const applied: Applied[] = [];
    const queue = queuedEffects();
    const otherScope: ProjectTargetScope = {
      kind: 'company',
      legalEntityId: otherLegalEntityId,
      principalId,
      tenantId: otherTenantId,
    };
    let reads = 0;
    const controller = new ProjectTargetController<ProjectTargetFailure>(
      (request, state) => {
        applied.push({ request, state });
      },
      projectTargetFailureStatus,
      () => {
        reads += 1;
        return Deferred.await(reads === 1 ? firstRead : secondRead);
      },
      queue.run,
    );
    controller.update({ enabled: true, request: requestOf(projectId, scope) });
    const stale = queue.take();
    controller.update({ enabled: true, request: requestOf(projectId, otherScope) });
    const current = queue.take();
    expect(reads).toBe(2);

    const staleFiber = yield* Effect.forkChild(stale);
    yield* Deferred.succeed(firstRead, project);
    yield* Fiber.join(staleFiber);
    expect(applied.some(({ state }) => state.status === 'ready')).toBe(false);

    const currentFiber = yield* Effect.forkChild(current);
    yield* Deferred.succeed(secondRead, { ...project, tenantId: otherTenantId });
    yield* Fiber.join(currentFiber);
    const ready = applied.at(-1)?.state;
    expect(ready?.status).toBe('ready');
    if (ready?.status === 'ready') {
      expect(ready.project.tenantId).toBe(otherTenantId);
    }
  }),
);

it.effect('a verified tenant-only destination reads and publishes its tenant Project without a company', () =>
  Effect.gen(function* tenantOnlyReady() {
    const deferred = yield* Deferred.make<Project>();
    const applied: Applied[] = [];
    const queue = queuedEffects();
    const controller = new ProjectTargetController<ProjectTargetFailure>(
      (request, state) => {
        applied.push({ request, state });
      },
      projectTargetFailureStatus,
      () => Deferred.await(deferred),
      queue.run,
    );
    controller.update({ enabled: true, request: requestOf(projectId, tenantScope) });
    expect(applied.at(-1)).toMatchObject({
      request: { projectId, scope: { kind: 'tenant', principalId, tenantId } },
      state: { projectId, status: 'loading' },
    });
    const fiber = yield* Effect.forkChild(queue.take());
    yield* Deferred.succeed(deferred, project);
    yield* Fiber.join(fiber);
    const state = applied.at(-1)?.state;
    expect(state?.status).toBe('ready');
    if (state?.status === 'ready') {
      expect(state.project.tenantId).toBe(tenantId);
      expect(state.projectId).toBe(projectId);
    }
  }),
);

it.effect('a tenant-only destination cancels a response when its tenant changes', () =>
  Effect.gen(function* staleTenantOnlyResponse() {
    const firstRead = yield* Deferred.make<Project>();
    const secondRead = yield* Deferred.make<Project>();
    const applied: Applied[] = [];
    const queue = queuedEffects();
    const otherTenantScope: ProjectTargetScope = { kind: 'tenant', principalId, tenantId: otherTenantId };
    let reads = 0;
    const controller = new ProjectTargetController<ProjectTargetFailure>(
      (request, state) => {
        applied.push({ request, state });
      },
      projectTargetFailureStatus,
      () => {
        reads += 1;
        return Deferred.await(reads === 1 ? firstRead : secondRead);
      },
      queue.run,
    );
    controller.update({ enabled: true, request: requestOf(projectId, tenantScope) });
    const stale = queue.take();
    controller.update({ enabled: true, request: requestOf(projectId, otherTenantScope) });
    const current = queue.take();
    expect(reads).toBe(2);

    const staleFiber = yield* Effect.forkChild(stale);
    yield* Deferred.succeed(firstRead, project);
    yield* Fiber.join(staleFiber);
    expect(applied.some(({ state }) => state.status === 'ready')).toBe(false);

    const currentFiber = yield* Effect.forkChild(current);
    yield* Deferred.succeed(secondRead, { ...project, tenantId: otherTenantId });
    yield* Fiber.join(currentFiber);
    const ready = applied.at(-1)?.state;
    expect(ready?.status).toBe('ready');
    if (ready?.status === 'ready') {
      expect(ready.project.tenantId).toBe(otherTenantId);
    }
  }),
);

it.effect('a tenant-only destination cancels a response when its principal changes', () =>
  Effect.gen(function* stalePrincipalOnlyResponse() {
    const firstRead = yield* Deferred.make<Project>();
    const secondRead = yield* Deferred.make<Project>();
    const applied: Applied[] = [];
    const queue = queuedEffects();
    const otherPrincipalScope: ProjectTargetScope = { kind: 'tenant', principalId: otherPrincipalId, tenantId };
    let reads = 0;
    const controller = new ProjectTargetController<ProjectTargetFailure>(
      (request, state) => {
        applied.push({ request, state });
      },
      projectTargetFailureStatus,
      () => {
        reads += 1;
        return Deferred.await(reads === 1 ? firstRead : secondRead);
      },
      queue.run,
    );
    controller.update({ enabled: true, request: requestOf(projectId, tenantScope) });
    const stale = queue.take();
    controller.update({ enabled: true, request: requestOf(projectId, otherPrincipalScope) });
    const current = queue.take();
    expect(reads).toBe(2);

    const staleFiber = yield* Effect.forkChild(stale);
    yield* Deferred.succeed(firstRead, project);
    yield* Fiber.join(staleFiber);
    expect(applied.some(({ state }) => state.status === 'ready')).toBe(false);

    const currentFiber = yield* Effect.forkChild(current);
    yield* Deferred.succeed(secondRead, project);
    yield* Fiber.join(currentFiber);
    const ready = applied.at(-1)?.state;
    expect(ready?.status).toBe('ready');
    if (ready?.status === 'ready') {
      expect(ready.project.tenantId).toBe(tenantId);
    }
  }),
);

test('cancel interrupts the active target read exactly once', () => {
  let interrupted = 0;
  const controller = new ProjectTargetController<ProjectTargetFailure>(
    () => {
      // No state application is needed for the interrupt assertion.
    },
    projectTargetFailureStatus,
    () => Effect.succeed(project),
    () => () => {
      interrupted += 1;
    },
  );
  controller.update({ enabled: true, request: requestOf() });
  expect(interrupted).toBe(0);
  controller.cancel();
  expect(interrupted).toBe(1);
  controller.cancel();
  expect(interrupted).toBe(1);
});

it.effect('a disabled lookup never reads or replaces an active panel', () =>
  Effect.gen(function* disabledLookup() {
    let reads = 0;
    const applied: Applied[] = [];
    const queue = queuedEffects();
    const controller = new ProjectTargetController<ProjectTargetFailure>(
      (request, state) => {
        applied.push({ request, state });
      },
      projectTargetFailureStatus,
      () => {
        reads += 1;
        return Effect.succeed(project);
      },
      queue.run,
    );
    controller.update({ enabled: false, request: requestOf() });
    expect(reads).toBe(0);
    expect(applied).toHaveLength(0);

    controller.update({ enabled: true, request: requestOf() });
    expect(reads).toBe(1);
    yield* queue.take();
    expect(applied.at(-1)?.state.status).toBe('ready');
  }),
);

it.effect('only a current-tenant exact record is ready; forbidden, missing and unavailable are truthful', () =>
  Effect.gen(function* truthfulFailures() {
    const forbidden = Schema.decodeUnknownSync(ReadProjectForbiddenProblemSchema)({
      _tag: 'ReadProjectForbiddenProblem',
      detail: 'Denied',
      status: 403,
      title: 'Forbidden',
      type: 'about:blank',
    });
    const notFound = Schema.decodeUnknownSync(ReadProjectNotFoundProblemSchema)({
      _tag: 'ReadProjectNotFoundProblem',
      detail: 'Not found',
      status: 404,
      title: 'Not found',
      type: 'about:blank',
    });
    const unavailable = Schema.decodeUnknownSync(ReadProjectUnavailableProblemSchema)({
      _tag: 'ReadProjectUnavailableProblem',
      detail: 'Unavailable',
      retryable: true,
      status: 503,
      title: 'Unavailable',
      type: 'about:blank',
    });
    const applied: Applied[] = [];
    const queue = queuedEffects();
    const controller = new ProjectTargetController<ProjectTargetFailure>(
      (request, state) => {
        applied.push({ request, state });
      },
      projectTargetFailureStatus,
      (id) => {
        if (id === projectId) {
          return Effect.fail(forbidden);
        }
        return Effect.fail(id === otherProjectId ? notFound : unavailable);
      },
      queue.run,
    );
    controller.update({ enabled: true, request: requestOf() });
    yield* queue.take();
    expect(applied.at(-1)?.state).toMatchObject({ projectId, status: 'forbidden' });

    controller.update({ enabled: true, request: requestOf(otherProjectId) });
    yield* queue.take();
    expect(applied.at(-1)?.state).toMatchObject({ projectId: otherProjectId, status: 'missing' });

    controller.update({ enabled: true, request: requestOf(thirdProjectId) });
    yield* queue.take();
    expect(applied.at(-1)?.state).toMatchObject({ projectId: thirdProjectId, status: 'unavailable' });
  }),
);
