// Create a Project: typing and Enter change only the draft, the shared Save button ("Uložit", last in the form) sends
// the create once, and leaving the page with typed input asks Uložit / Zahodit změny / Zůstat.
import {
  CreateProjectActionAlreadyCommittedProblemSchema,
  CreateProjectActionCommitIndeterminateProblemSchema,
} from '../../../../../shared/apis/create-project-action.ts';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime/consumer';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { RadioGroup } from '@techsio/ui-kit/molecules/radio-group';
import { Effect, Option, Random, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { useRef, useState } from 'react';
import { CreateProjectPayloadSchema } from '../../../../../shared/actions/create-project.ts';
import { ProjectPrefixInputSchema } from '../../../../../shared/domain/project.ts';
import { executeCreateProject } from '../../../../api/create-project-action-client.ts';
import { executeProjectOwnerCandidates } from '../../../../api/project-owner-candidates-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime';

const formKey = 'projects.pages.createProject';

interface OwnerCandidate {
  readonly displayName: string;
  readonly principalId: string;
}

/** Everything typed into the form. The owner search text is input too: leaving with it asks first. */
export interface CreateProjectDraft {
  readonly name: string;
  readonly ownerId: string;
  readonly prefix: string;
  readonly query: string;
  readonly shortText: string;
}

const emptyDraft: CreateProjectDraft = { name: '', ownerId: '', prefix: '', query: '', shortText: '' };

const LookupStatusSchema = Schema.Literals(['empty', 'forbidden', 'idle', 'loading', 'unavailable']);
type LookupStatus = typeof LookupStatusSchema.Type;
const CreateFailureSchema = Schema.Literals(['conflict', 'forbidden', 'invalid', 'uncertain', 'unavailable']);
type CreateFailure = typeof CreateFailureSchema.Type;
type CreateProjectError = Effect.Error<ReturnType<typeof executeCreateProject>>;

const correlation = Effect.gen(function* correlationId() {
  return `projects:${yield* Random.nextInt}:${yield* Random.nextInt}`;
});

interface OwnerLookup {
  readonly candidates: readonly OwnerCandidate[];
  readonly status: LookupStatus;
}

const loadOwners = Effect.fn('ProjectsPage.loadOwners')(function* loadOwners(prefix: string, query: string) {
  const correlationId = yield* correlation;
  return yield* executeProjectOwnerCandidates({ prefix, query }, correlationId).pipe(
    Effect.match({
      onFailure: (error): OwnerLookup => ({
        candidates: [],
        status: 'status' in error && error.status === 403 ? 'forbidden' : 'unavailable',
      }),
      onSuccess: (response): OwnerLookup => {
        // Field-projected results may omit personal names. Never render an unnamed candidate.
        const candidates = response.candidates.filter(
          (candidate): candidate is OwnerCandidate => candidate.displayName !== undefined,
        );
        return { candidates, status: candidates.length === 0 ? 'empty' : 'idle' };
      },
    }),
  );
});

const failureOf = (error: CreateProjectError): CreateFailure => {
  if (Schema.is(CreateProjectActionCommitIndeterminateProblemSchema)(error)) {
    return 'uncertain';
  }
  const status = 'status' in error ? error.status : 0;
  if (status === 401 || status === 403) {
    return 'forbidden';
  }
  if (status === 409) {
    return 'conflict';
  }
  return status === 400 || status === 422 ? 'invalid' : 'unavailable';
};

/** One create; an already committed request with the same key is the same success. */
const createProject = Effect.fn('ProjectsPage.createProject')(function* createProject(
  payload: typeof CreateProjectPayloadSchema.Type,
  idempotencyKey: string,
) {
  const correlationId = yield* correlation;
  return yield* executeCreateProject(payload, correlationId, { idempotencyKey }).pipe(
    Effect.match({
      onFailure: (error): CreateFailure | 'created' =>
        Schema.is(CreateProjectActionAlreadyCommittedProblemSchema)(error) ? 'created' : failureOf(error),
      onSuccess: (): CreateFailure | 'created' => 'created',
    }),
  );
});

const payloadOf = (draft: CreateProjectDraft) => ({
  name: draft.name,
  ownerPrincipalId: draft.ownerId,
  prefix: draft.prefix,
  shortText: draft.shortText === '' ? Option.none<string>() : Option.some(draft.shortText),
});

interface RequestKey {
  current: { readonly draft: CreateProjectDraft; readonly key: string } | null;
}

/** Uložit: one create of the draft. A retry of the same draft (for example after an uncertain answer) keeps its key. */
const saveDraft = Effect.fn('ProjectsPage.saveDraft')(function* saveDraft(
  value: CreateProjectDraft,
  requestKey: RequestKey,
  onFailure: (failure: CreateFailure | null) => void,
) {
  const key = requestKey.current?.draft === value ? requestKey.current.key : `projects:${yield* Random.nextInt}`;
  requestKey.current = { draft: value, key };
  const outcome = yield* createProject(payloadOf(value), key);
  onFailure(outcome === 'created' ? null : outcome);
  return outcome === 'created' ? 'saved' : 'failed';
});

export const CreateProjectForm = () => {
  const { language, t } = useModernI18n();
  const labels = saveLabelsFor(language);
  const [draft, setDraft] = useState<CreateProjectDraft>(emptyDraft);
  const [candidates, setCandidates] = useState<readonly OwnerCandidate[]>([]);
  const [lookup, setLookup] = useState<LookupStatus>('idle');
  const [failure, setFailure] = useState<CreateFailure | null>(null);
  // One idempotency key per draft: a retry of the same draft reuses it.
  const requestKey: RequestKey = useRef<RequestKey['current']>(null);
  const isValid = (value: CreateProjectDraft) =>
    Schema.is(CreateProjectPayloadSchema)(payloadOf(value)) &&
    candidates.some((candidate) => candidate.principalId === value.ownerId);
  const record = useDraftSave<CreateProjectDraft, never>({
    initial: emptyDraft,
    isValid: (value) => isValid(value),
    runtime: browserRuntime,
    save: (value) => saveDraft(value, requestKey, setFailure),
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: record,
    navigation: blocker,
    onDiscard: () => {
      setFailure(null);
      setDraft(record.confirmed);
      setCandidates([]);
      setLookup('idle');
    },
  });
  const saving = record.status === 'saving';
  // An uncertain create may have made the project: the inputs stay locked so Uložit can only retry this same draft
  // with its key, never send a changed one under a new key that could create a duplicate.
  const busy = saving || lookup === 'loading' || failure === 'uncertain';
  const edit = (patch: Partial<CreateProjectDraft>) => {
    setFailure(null);
    setDraft((current) => ({ ...current, ...patch }));
  };
  // The owner list belongs to the prefix and search text it was found for.
  const editLookup = (patch: Pick<Partial<CreateProjectDraft>, 'prefix' | 'query'>) => {
    edit({ ...patch, ownerId: '' });
    setCandidates([]);
    setLookup('idle');
  };
  const handleFindOwners = () => {
    edit({ ownerId: '' });
    setCandidates([]);
    setLookup('loading');
    browserRuntime.runFork(
      loadOwners(draft.prefix, draft.query).pipe(
        Effect.flatMap((result) =>
          Effect.sync(() => {
            setCandidates(result.candidates);
            setLookup(result.status);
          }),
        ),
      ),
    );
  };
  const handleSave = record.save;
  const statusKey = record.status === 'saved' ? 'success' : (failure ?? lookup);

  return (
    <form
      className="projects:mt-6 projects:grid projects:gap-4"
      onSubmit={(event) => {
        // Enter never creates: only Uložit sends the draft.
        event.preventDefault();
      }}
    >
      <FormInput
        disabled={busy}
        id="project-name"
        label={t(`${formKey}.name`)}
        onChange={(event) => edit({ name: event.target.value })}
        required
        value={draft.name}
      />
      <FormInput
        disabled={busy}
        helpText={t(`${formKey}.prefixHelp`)}
        id="project-prefix"
        label={t(`${formKey}.prefixLabel`)}
        onChange={(event) => editLookup({ prefix: event.target.value })}
        required
        value={draft.prefix}
      />
      <FormTextarea
        disabled={busy}
        id="project-short-text"
        label={t(`${formKey}.shortText`)}
        onChange={(event) => edit({ shortText: event.target.value })}
        value={draft.shortText}
      />
      <FormInput
        disabled={busy}
        id="project-owner-query"
        label={t(`${formKey}.ownerQuery`)}
        onChange={(event) => editLookup({ query: event.target.value })}
        value={draft.query}
      />
      <Button
        disabled={busy || !Schema.is(ProjectPrefixInputSchema)(draft.prefix)}
        isLoading={lookup === 'loading'}
        onClick={handleFindOwners}
        type="button"
        variant="secondary"
      >
        {t(`${formKey}.findOwners`)}
      </Button>
      <RadioGroup
        disabled={busy}
        name="project-owner"
        onValueChange={(value) => edit({ ownerId: value ?? '' })}
        required
        value={draft.ownerId}
      >
        <RadioGroup.Label>{t(`${formKey}.owner`)}</RadioGroup.Label>
        <RadioGroup.ItemGroup>
          {candidates.map((candidate) => (
            <RadioGroup.Item key={candidate.principalId} value={candidate.principalId}>
              <RadioGroup.ItemHiddenInput />
              <RadioGroup.ItemControl />
              <RadioGroup.ItemContent>
                <RadioGroup.ItemText>{candidate.displayName}</RadioGroup.ItemText>
              </RadioGroup.ItemContent>
            </RadioGroup.Item>
          ))}
        </RadioGroup.ItemGroup>
      </RadioGroup>
      <p aria-live="polite">{t(`${formKey}.${statusKey}`)}</p>
      <SaveBar
        error={failure === null ? null : t(`${formKey}.${failure}`)}
        labels={labels}
        onReloadLatest={constVoid}
        onSave={handleSave}
        status={record.status}
      />
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </form>
  );
};
