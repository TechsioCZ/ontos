// Create a Project: typing and Enter change only the form, the shared Save button ("Uložit", last in the form) sends
// the create once, and leaving the page with typed input asks Uložit / Zahodit změny / Zůstat.
import {
  CreateProjectActionAlreadyCommittedProblemSchema,
  CreateProjectActionCommitIndeterminateProblemSchema,
} from '../../../../../shared/apis/create-project-action.ts';
import {
  SaveBar,
  UnsavedChangesDialog,
  draftSavable,
  draftUnsaved,
  requiredLabelFor,
  saveLabelsFor,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SavableDraft, SaveState } from '@app/admin-ui';
import {
  FormReact,
  FormRoot,
  OptionalTextAreaField,
  RadioField,
  TextField,
  fromPayload,
  makeActionAttempt,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
  useFormPending,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Match, Option, Random, Schema, Struct } from 'effect';
import { constVoid } from 'effect/Function';
import { AsyncResult, Atom } from 'effect/reactivity';
import { useRef } from 'react';
import { CreateProjectPayloadSchema } from '../../../../../shared/actions/create-project.ts';
import type { CreateProjectPayload } from '../../../../../shared/actions/create-project.ts';
import { ProjectOwnerCandidatesRequestSchema } from '../../../../../shared/apis/project-owner-candidates.ts';
import { executeCreateProject } from '../../../../api/create-project-action-client.ts';
import { executeProjectOwnerCandidates } from '../../../../api/project-owner-candidates-client.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime';
import { OwnerLookupFailed } from './owner-lookup-failed.ts';
import { CreateProjectRefused } from './refusals.ts';

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

/**
 * Set once a create's commit outcome is unknown, until a create commits: the form stays locked, so Uložit can only
 * retry the same payload under its key, never send a changed one under a new key that could create a duplicate.
 */
const commitUncertain = Atom.make(false).pipe(Atom.keepAlive);

type CreateProjectFormPayload = Omit<CreateProjectPayload, 'parentProjectId'>;

const attempt = makeActionAttempt<CreateProjectFormPayload, never>(requestKey());

const createProject = Effect.fn('ProjectsPage.createProject')(function* createProject(
  { ownerQuery, payload }: { readonly ownerQuery: string; readonly payload: CreateProjectFormPayload },
  get: Atom.FnContext,
) {
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
  yield* Effect.sync(() => get.set(commitUncertain, false));
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
        // The page shows an unknown commit outcome on its own, for as long as it locks the form.
        Match.when('uncertain', () => []),
        Match.orElse((other) => [{ message: `${page}.${other}`, path: '' as const }]),
      ),
  },
);

type CreateProjectValues = typeof createProjectForm.schema.Encoded;

/** The empty form: what an untouched page shows, and what leaving without asking compares with. */
const emptyValues: CreateProjectValues = {
  name: '',
  ownerPrincipalId: '',
  ownerQuery: '',
  prefix: '',
  shortText: null,
};

const decodesAsPayload = (value: CreateProjectValues): boolean =>
  Option.isSome(Schema.decodeUnknownOption(createProjectForm.schema)(value));

const ownerField = createProjectForm.getFieldAtoms(createProjectForm.fields.ownerPrincipalId);
const prefixField = createProjectForm.getFieldAtoms(createProjectForm.fields.prefix);
const ownerQueryField = createProjectForm.getFieldAtoms(createProjectForm.fields.ownerQuery);

/**
 * The text of a search field as a plain string. It changes only when the text does: the field's own value atom
 * reports every change of the form, so clearing the owner on it would clear again forever.
 */
const searchText = (value: Atom.Atom<Option.Option<string>>) => value.pipe(Atom.map(Option.getOrElse(() => '')));
const searchPrefix = searchText(prefixField.value);
const searchQuery = searchText(ownerQueryField.value);

const OwnerSearch = () => {
  const { t } = useModernI18n();
  const pending = useFormPending();
  const prefix = useAtomValue(searchPrefix);
  const query = useAtomValue(searchQuery);
  const input = { prefix, query };
  const candidates = useAtomValue(ownerCandidates);
  const find = useAtomSet(ownerCandidates);
  const setOwner = useAtomSet(ownerField.setValue);
  // An owner is chosen from one search: editing what was searched for drops the choice.
  useAtomSubscribe(searchPrefix, () => setOwner(''), { immediate: false });
  useAtomSubscribe(searchQuery, () => setOwner(''), { immediate: false });
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
  const handleFindOwners = () => {
    setOwner('');
    find(input);
  };
  return (
    <>
      <createProjectForm.ownerQuery id="project-owner-query" label={t(`${page}.ownerQuery`)} />
      <Button
        disabled={pending || !Schema.is(ProjectOwnerCandidatesRequestSchema)(input)}
        isLoading={candidates.waiting}
        onClick={handleFindOwners}
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

const CommitUncertain = () => {
  const { t } = useModernI18n();
  return useAtomValue(commitUncertain) ? (
    <StatusText aria-live="polite" status="warning">
      {t(`${page}.uncertain`)}
    </StatusText>
  ) : null;
};

/** How the latest create ended, as the save bar names it. */
const settledStatus = (result: Atom.Type<typeof createProjectForm.submit>): SaveState =>
  AsyncResult.isSuccess(result) ? 'saved' : 'error';

/**
 * The create as the shared save bar and the unsaved-changes guard read it, derived from the form's own state: an
 * untouched form is `idle`, a changed one `dirty` or `invalid`, and once a create ran its values stay `saved` (or
 * `error`) until they change. Uložit submits the form; nothing else does.
 */
const useCreateSave = (valid: (values: CreateProjectValues) => boolean): SavableDraft => {
  const result = useAtomValue(createProjectForm.submit);
  const changed = useAtomValue(createProjectForm.hasChangedSinceSubmit);
  const dirty = useAtomValue(createProjectForm.isDirty);
  const submitted = useAtomValue(createProjectForm.submitCount) > 0;
  const values = Option.getOrElse(useAtomValue(createProjectForm.values), () => emptyValues);
  const submit = useAtomSet(createProjectForm.submit);
  // Whoever started a save and acts on how it ended (the guard's Uložit, then leaving).
  const waiting = useRef<{ readonly done: Set<(status: SaveState) => void>; saving: boolean }>({
    done: new Set(),
    saving: false,
  });
  useAtomSubscribe(
    createProjectForm.submit,
    (next) => {
      if (next.waiting || AsyncResult.isInitial(next)) {
        return;
      }
      const done = [...waiting.current.done];
      const ended = settledStatus(next);
      waiting.current.done.clear();
      waiting.current.saving = false;
      for (const answer of done) {
        answer(ended);
      }
    },
    { immediate: false },
  );
  const status: SaveState = Match.value({ changed, dirty, result, submitted }).pipe(
    Match.when({ result: { waiting: true } }, (): SaveState => 'saving'),
    Match.when({ changed: false, submitted: true }, ({ result: settled }) =>
      AsyncResult.isInitial(settled) ? 'idle' : settledStatus(settled),
    ),
    Match.when({ dirty: false }, (): SaveState => 'idle'),
    Match.orElse((): SaveState => (valid(values) ? 'dirty' : 'invalid')),
  );
  return {
    afterSave: (done) => {
      if (waiting.current.saving) {
        waiting.current.done.add(done);
        return;
      }
      done(status);
    },
    canSave: draftSavable(status),
    dirty: draftUnsaved(status),
    save: () => {
      if (waiting.current.saving || !draftSavable(status)) {
        return;
      }
      waiting.current.saving = true;
      submit();
    },
    status,
  };
};

/** Uložit with the status of the create, the question before leaving typed input, and the created notice. */
const CreateProjectSave = ({ translate }: { readonly translate: (message: string) => string }) => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const candidates = useAtomValue(ownerCandidates);
  const rootError = useAtomValue(createProjectForm.rootError);
  const setValues = useAtomSet(createProjectForm.setValues);
  const resetOwners = useAtomSet(ownerCandidates);
  const record = useCreateSave(
    (values) =>
      decodesAsPayload(values) &&
      currentOwners(candidates, { prefix: values.prefix, query: values.ownerQuery }).some(
        (owner) => owner.value === values.ownerPrincipalId,
      ),
  );
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => {
      setValues(emptyValues);
      resetOwners(Atom.Reset);
    },
  });
  const handleSave = record.save;
  return (
    <>
      {record.status === 'saved' ? (
        <StatusText aria-live="polite" status="success">
          {t(`${page}.success`)}
        </StatusText>
      ) : null}
      <SaveBar
        error={Option.match(rootError, { onNone: () => null, onSome: translate })}
        labels={labels}
        onReloadLatest={constVoid}
        onSave={handleSave}
        status={record.status}
      />
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

/**
 * The create form. It has no submit button, so Enter submits nothing: only Uložit sends the form, once, and a retry
 * of the same values keeps their idempotency key. While an owner lookup or a save runs, and after an uncertain
 * create, every input is locked.
 */
export const CreateProjectForm = () => {
  const { language, t } = useModernI18n();
  const requiredLabel = requiredLabelFor(language);
  const translate = (message: string) => t(message, { defaultValue: t(`${page}.invalid`) });
  const lookingUp = useAtomValue(ownerCandidates).waiting;
  const uncertain = useAtomValue(commitUncertain);
  return (
    <FormRoot
      blocked={uncertain || lookingUp}
      className="projects:mt-6 projects:grid projects:gap-4"
      defaultValues={emptyValues}
      form={createProjectForm}
      translateMessage={translate}
    >
      <createProjectForm.name id="project-name" label={t(`${page}.name`)} required requiredLabel={requiredLabel} />
      <createProjectForm.prefix
        helpText={t(`${page}.prefixHelp`)}
        id="project-prefix"
        label={t(`${page}.prefixLabel`)}
        required
        requiredLabel={requiredLabel}
      />
      <createProjectForm.shortText id="project-short-text" label={t(`${page}.shortText`)} />
      <OwnerSearch />
      <CommitUncertain />
      <CreateProjectSave translate={translate} />
    </FormRoot>
  );
};
