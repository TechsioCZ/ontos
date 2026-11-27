import {
  CreateProjectActionAlreadyCommittedProblemSchema,
  CreateProjectActionCommitIndeterminateProblemSchema,
} from '../../../../../shared/apis/create-project-action.ts';
import {
  FormReact,
  FormRoot,
  FormRootError,
  OptionalTextAreaField,
  RadioField,
  SubmitButton,
  TextField,
  fromPayload,
  makeActionAttempt,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Match, Option, Random, Schema, Struct } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { CreateProjectPayloadSchema } from '../../../../../shared/actions/create-project.ts';
import type { CreateProjectPayload } from '../../../../../shared/actions/create-project.ts';
import { ProjectOwnerCandidatesRequestSchema } from '../../../../../shared/apis/project-owner-candidates.ts';
import { executeCreateProject } from '../../../../api/create-project-action-client.ts';
import { executeProjectOwnerCandidates } from '../../../../api/project-owner-candidates-client.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime';
import { UltramodernRouteHead } from '../../../ultramodern-route-head';
import { OwnerLookupFailed } from './owner-lookup-failed.ts';
import { CreateProjectRefused } from './refusals.ts';
import { projectsI18nResources } from '../../../../i18n/resources';

const page = 'projects.pages.createProject';
const requestKey = Effect.fn('ProjectsPage.requestKey')(function* requestKey() {
  return `projects:${yield* Random.nextInt}:${yield* Random.nextInt}`;
});

type CreateProjectFailure = Effect.Error<ReturnType<typeof executeCreateProject>>;

const refusalOfStatus = (status: number, code: string | undefined): CreateProjectRefused['reason'] => {
  if (code === 'project_prefix_conflict') {
    return 'prefixTaken';
  }
  if (code === 'project_owner_not_eligible') {
    return 'ineligibleOwner';
  }
  if (status === 401 || status === 403) {
    return 'forbidden';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status === 400 || status === 422) {
    return 'invalid';
  }
  return 'unavailable';
};

const refusal = (failure: CreateProjectFailure): CreateProjectRefused['reason'] => {
  if (Schema.is(CreateProjectActionCommitIndeterminateProblemSchema)(failure)) {
    return 'uncertain';
  }
  // A failure without an answer from the Action (a dropped connection, an unreadable response) may
  // still have committed, so it counts as an unknown outcome, never as a plain retry.
  return 'status' in failure
    ? refusalOfStatus(failure.status, 'code' in failure ? failure.code : undefined)
    : 'uncertain';
};

interface OwnerSearchInput {
  readonly prefix: string;
  readonly query: string;
}

const loadOwnerCandidates = Effect.fn('ProjectsPage.loadOwnerCandidates')(function* loadOwnerCandidates(
  input: OwnerSearchInput,
) {
  const correlationId = yield* requestKey();
  const response = yield* executeProjectOwnerCandidates(input, correlationId).pipe(
    Effect.mapError(
      (failure) =>
        new OwnerLookupFailed({
          reason: 'status' in failure && failure.status === 403 ? 'forbidden' : 'unavailable',
        }),
    ),
  );
  // Field-projected results may omit personal names. Never render an unnamed candidate.
  const candidates = response.candidates.flatMap((candidate) =>
    candidate.displayName === undefined ? [] : [{ label: candidate.displayName, value: candidate.principalId }],
  );
  return { candidates, input };
});

const ownerCandidates = browserAtomRuntime.fn(loadOwnerCandidates);

/** The owners of the latest completed lookup, and only while the search inputs are the ones it used. */
const currentOwners = (
  result: AsyncResult.AsyncResult<Effect.Success<ReturnType<typeof loadOwnerCandidates>>, OwnerLookupFailed>,
  input: OwnerSearchInput,
) =>
  AsyncResult.isSuccess(result) &&
  !result.waiting &&
  result.value.input.prefix === input.prefix &&
  result.value.input.query === input.query
    ? result.value.candidates
    : [];

/** Set once a create's commit outcome is unknown: no further create may start from this page. */
const commitUncertain = Atom.make(false).pipe(Atom.keepAlive);

type CreateProjectFormPayload = Omit<CreateProjectPayload, 'parentProjectId'>;

const attempt = makeActionAttempt<CreateProjectFormPayload, never>(requestKey());

const createProject = Effect.fn('ProjectsPage.createProject')(function* createProject(
  { ownerQuery, payload }: { readonly ownerQuery: string; readonly payload: CreateProjectFormPayload },
  get: Atom.FnContext,
) {
  if (get(commitUncertain)) {
    return yield* new CreateProjectRefused({ reason: 'uncertain' });
  }
  const shown = currentOwners(get(ownerCandidates), { prefix: payload.prefix, query: ownerQuery });
  if (!shown.some((owner) => owner.value === payload.ownerPrincipalId)) {
    return yield* new CreateProjectRefused({ reason: 'ineligibleOwner' });
  }
  const [idempotencyKey, correlationId] = yield* Effect.all([attempt.key(get, payload), requestKey()], {
    concurrency: 2,
  });
  yield* executeCreateProject(payload, correlationId, { idempotencyKey }).pipe(
    Effect.asVoid,
    Effect.catchIf(Schema.is(CreateProjectActionAlreadyCommittedProblemSchema), () => Effect.void),
    Effect.mapError((failure) => new CreateProjectRefused({ reason: refusal(failure) })),
    Effect.tapError(({ reason }) =>
      Effect.sync(() => {
        if (reason === 'uncertain') {
          get.set(commitUncertain, true);
        }
      }),
    ),
  );
  return yield* attempt.settle(get);
});

/** Every field and check comes from the Action payload; the owner search query is the form's own. */
const createProjectForm = FormReact.make(
  fromPayload(
    CreateProjectPayloadSchema.mapFields(Struct.pick(['name', 'ownerPrincipalId', 'prefix', 'shortText'])),
  ).addField('ownerQuery', ProjectOwnerCandidatesRequestSchema.fields.query),
  {
    fields: {
      name: TextField,
      ownerPrincipalId: RadioField,
      ownerQuery: TextField,
      prefix: TextField,
      shortText: OptionalTextAreaField,
    },
    onSubmit: (_submit, { decoded: { ownerQuery, ...payload }, get }) => createProject({ ownerQuery, payload }, get),
    runtime: browserAtomRuntime,
    submitErrors: ({ reason }) =>
      Match.value(reason).pipe(
        Match.when('prefixTaken', () => [{ message: `${page}.conflict`, path: 'prefix' as const }]),
        Match.when('ineligibleOwner', () => [{ message: `${page}.invalid`, path: 'ownerPrincipalId' as const }]),
        // The page shows an unknown commit outcome on its own, for as long as it blocks the form.
        Match.when('uncertain', () => []),
        Match.orElse((other) => [{ message: `${page}.${other}`, path: '' as const }]),
      ),
  },
);

const ownerField = createProjectForm.getFieldAtoms(createProjectForm.fields.ownerPrincipalId);
const prefixField = createProjectForm.getFieldAtoms(createProjectForm.fields.prefix);
const ownerQueryField = createProjectForm.getFieldAtoms(createProjectForm.fields.ownerQuery);

const OwnerSearch = () => {
  const { t } = useModernI18n();
  const input = {
    prefix: Option.getOrElse(useAtomValue(prefixField.value), () => ''),
    query: Option.getOrElse(useAtomValue(ownerQueryField.value), () => ''),
  };
  const candidates = useAtomValue(ownerCandidates);
  const find = useAtomSet(ownerCandidates);
  const setOwner = useAtomSet(ownerField.setValue);
  // An owner is chosen from one search: editing what was searched for drops the choice.
  useAtomSubscribe(prefixField.value, () => setOwner(''), { immediate: false });
  useAtomSubscribe(ownerQueryField.value, () => setOwner(''), { immediate: false });
  const items = currentOwners(candidates, input);
  const status = AsyncResult.match(candidates, {
    onFailure: () =>
      Option.match(AsyncResult.error(candidates), { onNone: () => 'unavailable', onSome: ({ reason }) => reason }),
    onInitial: () => 'idle',
    onSuccess: () =>
      items.length === 0 &&
      AsyncResult.isSuccess(candidates) &&
      candidates.value.input.prefix === input.prefix &&
      candidates.value.input.query === input.query
        ? 'empty'
        : 'idle',
  });
  return (
    <>
      <createProjectForm.ownerQuery id="project-owner-query" label={t(`${page}.ownerQuery`)} />
      <Button
        disabled={candidates.waiting || !Schema.is(ProjectOwnerCandidatesRequestSchema)(input)}
        isLoading={candidates.waiting}
        onClick={() => {
          setOwner('');
          find(input);
        }}
        severity="secondary"
        type="button"
      >
        {t(`${page}.findOwners`)}
      </Button>
      <createProjectForm.ownerPrincipalId items={items} label={t(`${page}.owner`)} />
      <StatusText aria-live="polite">{t(`${page}.${candidates.waiting ? 'loading' : status}`)}</StatusText>
    </>
  );
};

const CreateProjectResult = () => {
  const { t } = useModernI18n();
  const result = useAtomValue(createProjectForm.submit);
  return AsyncResult.isSuccess(result) && !result.waiting ? (
    <StatusText aria-live="polite" status="success">
      {t(`${page}.success`)}
    </StatusText>
  ) : null;
};

const CommitUncertain = () => {
  const { t } = useModernI18n();
  return useAtomValue(commitUncertain) ? (
    <StatusText aria-live="polite" status="warning">
      {t(`${page}.uncertain`)}
    </StatusText>
  ) : null;
};

const CreateProjectPageContent = () => {
  const { t } = useModernI18n();
  const uncertain = useAtomValue(commitUncertain);
  const headingId = 'create-project-heading';
  return (
    <>
      <UltramodernRouteHead />
      <section aria-labelledby={headingId} className="mx-auto w-full max-w-5xl px-200 py-400 sm:px-400 lg:px-550">
        <h1 className="text-3xl font-bold text-fg-primary sm:text-4xl" id={headingId}>
          {t(`${page}.title`)}
        </h1>
        <FormRoot
          blocked={uncertain}
          className="mt-300 grid gap-200"
          defaultValues={{ name: '', ownerPrincipalId: '', ownerQuery: '', prefix: '', shortText: null }}
          form={createProjectForm}
          translateMessage={(message) => t(message, { defaultValue: t(`${page}.invalid`) })}
        >
          <createProjectForm.name id="project-name" label={t(`${page}.name`)} required />
          <createProjectForm.prefix
            helpText={t(`${page}.prefixHelp`)}
            id="project-prefix"
            label={t(`${page}.prefixLabel`)}
            required
          />
          <createProjectForm.shortText id="project-short-text" label={t(`${page}.shortText`)} />
          <OwnerSearch />
          <FormRootError form={createProjectForm} />
          <CommitUncertain />
          <CreateProjectResult />
          <SubmitButton>{t(`${page}.submit`)}</SubmitButton>
        </FormRoot>
      </section>
    </>
  );
};

const CreateProjectPage = () => (
  <FederatedI18nBoundary
    defaultNamespace="projects"
    fallbackLanguage="en"
    resources={projectsI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <CreateProjectPageContent />
  </FederatedI18nBoundary>
);

export default CreateProjectPage;
