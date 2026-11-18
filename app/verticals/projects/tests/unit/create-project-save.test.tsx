// @rstest-environment happy-dom
// The real create form, module copy, router guard and generated clients run against the owner's HTTP contracts.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import type { AnyRouter } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { createProjectActionSchemaErrorLive } from '../../api/create-project-action-problems.ts';
import { CreateProjectResultSchema } from '../../shared/actions/create-project.ts';
import type { CreateProjectPayloadSchema } from '../../shared/actions/create-project.ts';
import { CreateProjectActionApi } from '../../shared/apis/create-project-action.ts';
import type { CreateProjectActionCommitIndeterminateProblemSchema } from '../../shared/apis/create-project-action.ts';
import { ProjectOwnerCandidatesApi } from '../../shared/apis/project-owner-candidates.ts';
import { projectsI18nResources } from '../../src/i18n/resources.ts';
import { CreateProjectForm } from '../../src/routes/[lang]/projects/create-project/create-project-form.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const owner = { displayName: 'Jana', principalId: '00000000-0000-4000-8000-000000000021' };
const created = Schema.decodeUnknownSync(CreateProjectResultSchema)({
  createdAt: '2026-11-10T12:00:00.000Z',
  createdByPrincipalId: owner.principalId,
  lifecycleState: 'active',
  name: 'Nový web',
  ownerPrincipalId: owner.principalId,
  parentProjectId: null,
  prefix: 'WEB',
  projectId: '00000000-0000-4000-8000-000000000022',
  shortText: null,
  tenantId: '00000000-0000-4000-8000-000000000023',
});
const uncertain: typeof CreateProjectActionCommitIndeterminateProblemSchema.Type = {
  _tag: 'CreateProjectActionCommitIndeterminateProblem',
  detail: 'uncertain',
  invocationId: 'invocation-1',
  resolution: 'RESOLVE_COMMIT',
  retryCommand: false,
  status: 503,
  title: 'uncertain',
  type: 'about:blank',
};
const commands: { readonly key: string | undefined; readonly payload: typeof CreateProjectPayloadSchema.Encoded }[] =
  [];
let answer: Effect.Effect<typeof created, typeof uncertain> = Effect.succeed(created);
const OwnerActionApi = CreateProjectActionApi.prefix('/projects-api');
const OwnerCandidatesApi = ProjectOwnerCandidatesApi.prefix('/projects-api');
const network = browserNetwork(
  shellGatewayIssuer({ projects: '/projects-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'createProjectAction', (group) =>
      group.handle('execute', ({ payload, request }) =>
        Effect.suspend(() => {
          commands.push({ key: request.headers['idempotency-key'], payload });
          return answer;
        }),
      ),
    ).pipe(Layer.provide(createProjectActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerCandidatesApi,
    HttpApiBuilder.group(OwnerCandidatesApi, 'projectOwnerCandidates', (group) =>
      group.handle('execute', () => Effect.succeed({ candidates: [owner] })),
    ),
  ),
);

const labels = saveLabelsFor('cs');
const copy = moduleText('cs', projectsI18nResources);
const buttonNamed = (name: string): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(name)[0]));
const field = (selector: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(selector)));
const typeInto = (id: string, value: string) =>
  acted(() => {
    const input = field(`#${id}`);
    const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const mount = () =>
  mountInRoute(<CreateProjectForm />, {
    resources: projectsI18nResources,
    url: '/cs/projects/create-project',
  });

const expectBlocked = (router: AnyRouter) =>
  Effect.gen(function* blockedDeparture() {
    const previous = router.state.location.href;
    yield* acted(() => {
      void router.navigate({ to: '/cs/other' });
    });
    yield* waitUntil(() => buttons(labels.discard).length === 1);
    expect(router.state.location.href).toBe(previous);
    expect(buttons(labels.discard)).toHaveLength(1);
    yield* acted(() => buttonNamed(labels.stay).click());
    yield* waitUntil(() => buttons(labels.discard).length === 0);
  });
const expectAllowed = (router: AnyRouter, destination: string) =>
  Effect.gen(function* allowedDeparture() {
    yield* acted(() => {
      void router.navigate({ to: destination });
    });
    yield* waitUntil(() => router.state.location.href === destination);
    expect(router.state.location.href).toBe(destination);
    expect(buttons(labels.discard)).toHaveLength(0);
  });
const fill = Effect.gen(function* fillDraft() {
  yield* typeInto('project-name', 'Nový web');
  yield* typeInto('project-prefix', 'WEB');
  yield* acted(() => buttonNamed(copy('projects.pages.createProject.findOwners')).click());
  yield* waitUntil(() => document.querySelector(`input[value="${owner.principalId}"]`) !== null);
  yield* acted(() => field(`input[value="${owner.principalId}"]`).click());
});

beforeEach(() => {
  commands.length = 0;
  answer = Effect.succeed(created);
});
afterEach(unmountAll);

it.live('typing and Enter send nothing; Uložit creates once and the page can be left', () =>
  Effect.gen(function* createOnce() {
    yield* pinTestDocument;
    const { router } = yield* mount();
    yield* expectAllowed(router, '/cs/projects/create-project?clean=1');
    yield* fill;
    yield* acted(() => field('#project-name').form?.requestSubmit());
    expect(commands).toHaveLength(0);
    yield* expectBlocked(router);
    yield* acted(() => buttonNamed(labels.save).click());
    yield* waitUntil(() => text().includes(labels.saved));
    expect(commands).toHaveLength(1);
    expect(commands[0]?.payload).toMatchObject({
      name: 'Nový web',
      ownerPrincipalId: owner.principalId,
      prefix: 'WEB',
    });
    yield* expectAllowed(router, '/cs/other');
  }).pipe(Effect.provide(network)),
);

it.live('an uncertain create locks the inputs, and Uložit retries the same draft with the same key', () =>
  Effect.gen(function* uncertainLock() {
    yield* pinTestDocument;
    answer = Effect.fail(uncertain);
    const { router } = yield* mount();
    yield* fill;
    yield* acted(() => buttonNamed(labels.save).click());
    yield* waitUntil(() => document.querySelector('[data-save-state="error"]') !== null);
    expect(field('#project-name').disabled).toBe(true);
    expect(field('#project-prefix').disabled).toBe(true);
    expect(buttonNamed(copy('projects.pages.createProject.findOwners')).disabled).toBe(true);
    answer = Effect.succeed(created);
    yield* acted(() => buttonNamed(labels.save).click());
    yield* waitUntil(() => text().includes(labels.saved));
    expect(commands).toHaveLength(2);
    expect(commands[1]?.payload).toEqual(commands[0]?.payload);
    expect(commands[0]?.key).toEqual(expect.any(String));
    expect(commands[1]?.key).toEqual(commands[0]?.key);
    yield* expectAllowed(router, '/cs/other');
  }).pipe(Effect.provide(network)),
);

it.live('leaving with typed input asks, and Zahodit změny leaves without creating', () =>
  Effect.gen(function* leaveDiscard() {
    yield* pinTestDocument;
    const { rerender, router } = yield* mount();
    yield* typeInto('project-name', 'Rozpracovaný');
    yield* expectBlocked(router);
    const arrivals: string[] = [];
    const unsubscribe = router.subscribe('onResolved', (event) => {
      arrivals.push(event.toLocation.pathname);
    });
    yield* acted(() => {
      void router.navigate({ to: '/cs/other' });
    });
    yield* waitUntil(() => buttons(labels.discard).length === 1);
    yield* acted(() => buttonNamed(labels.discard).click());
    yield* waitUntil(() => router.state.location.pathname === '/cs/other');
    expect(arrivals).toEqual(['/cs/other']);
    unsubscribe();
    expect(commands).toHaveLength(0);
    yield* rerender(<CreateProjectForm />);
    expect(field('#project-name').value).toBe('');
    yield* expectAllowed(router, '/cs/another');
  }).pipe(Effect.provide(network)),
);
