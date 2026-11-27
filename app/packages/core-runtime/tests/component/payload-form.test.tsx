import { RegistryProvider, useAtomSet } from '@effect/atom-react';
import { Button } from '@techsio/ui-kit/atoms/button';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Deferred, Effect, Match, Option, Ref, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';

import {
  FormBuilder,
  FormReact,
  FormRoot,
  FormRootError,
  OptionalTextField,
  SubmitButton,
  TextField,
  fromPayload,
  makeActionAttempt,
} from '../../src/ui/form/index.ts';

/** An Action payload as a module declares it: the form takes its fields and checks from here. */
const RenameProjectPayload = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1, { message: 'form.name.required' })),
  note: Schema.optionalKey(Schema.OptionFromNullOr(Schema.String)),
  prefix: Schema.String.check(Schema.isPattern(/^[A-Z]{2,5}$/u, { message: 'form.prefix.invalid' })),
});
type RenameProject = typeof RenameProjectPayload.Type;

/** Why the server double refused: a taken prefix belongs to its field, an outage to the form. */
class RenameRefused extends Schema.TaggedError<RenameRefused>()('RenameRefused', {
  reason: Schema.Literals(['prefixTaken', 'unavailable']),
}) {}

const sent: { key: string; payload: RenameProject }[] = [];
const issued = Ref.makeUnsafe(0);
const attempt = makeActionAttempt<RenameProject, never>(
  Ref.updateAndGet(issued, (count) => count + 1).pipe(Effect.map((count) => `key-${count}`)),
);

const refusals = { DOWN: 'unavailable', TAKEN: 'prefixTaken' } as const;

const rename = Effect.fn('test.rename')(function* rename(
  payload: RenameProject,
  get: Parameters<typeof attempt.key>[0],
) {
  const key = yield* attempt.key(get, payload);
  sent.push({ key, payload });
  const reason = payload.prefix === 'DOWN' || payload.prefix === 'TAKEN' ? refusals[payload.prefix] : undefined;
  return reason === undefined ? undefined : yield* new RenameRefused({ reason });
});

const renameForm = FormReact.make(fromPayload(RenameProjectPayload), {
  fields: { name: TextField, note: OptionalTextField, prefix: TextField },
  onSubmit: (_submit, { decoded, get }) => rename(decoded, get),
  submitErrors: ({ reason }) =>
    Match.value(reason).pipe(
      Match.when('prefixTaken', () => [{ message: 'form.prefix.taken', path: 'prefix' as const }]),
      Match.orElse(() => [{ message: 'form.unavailable', path: '' as const }]),
    ),
});

const messages = new Map([
  ['form.name.required', 'Enter a name.'],
  ['form.prefix.invalid', 'Use 2 to 5 capital letters.'],
  ['form.prefix.taken', 'This prefix is taken.'],
  ['form.unavailable', 'Try again later.'],
]);

/** Field labels come from the module's locale resources; the test reads them through this table. */
const labels = { name: 'Name', note: 'Note', prefix: 'Prefix' } as const;

const RenameProjectForm = () => (
  <RegistryProvider>
    <FormRoot
      defaultValues={{ name: '', note: null, prefix: '' }}
      form={renameForm}
      translateMessage={(message) => messages.get(message) ?? message}
    >
      <renameForm.name label={labels.name} />
      <renameForm.prefix label={labels.prefix} />
      <renameForm.note label={labels.note} />
      <FormRootError form={renameForm} />
      <SubmitButton>Save</SubmitButton>
    </FormRoot>
  </RegistryProvider>
);

const user = () => userEvent.setup();
const type = (label: string, text: string) => Effect.promise(() => user().type(screen.getByLabelText(label), text));
const save = Effect.promise(() => user().click(screen.getByRole('button', { name: 'Save' })));
const shown = (text: string) => Effect.promise(() => screen.findByText(text));
const invalid = (label: string) => screen.getByLabelText(label).getAttribute('aria-invalid');

afterEach(() => {
  cleanup();
  sent.length = 0;
});

it.effect('shows the payload Schema checks as translated field errors and sends nothing', () =>
  Effect.gen(function* schemaChecks() {
    render(<RenameProjectForm />);
    yield* save;
    yield* shown('Enter a name.');
    expect(screen.getByText('Use 2 to 5 capital letters.')).toBeDefined();
    expect(invalid('Name')).toBe('true');
    expect(sent).toEqual([]);
  }),
);

it.effect('submits the decoded payload, maps a refusal to its field and reuses the key for the same payload', () =>
  Effect.gen(function* fieldRefusal() {
    render(<RenameProjectForm />);
    yield* type('Name', 'Apollo');
    yield* type('Prefix', 'TAKEN');
    yield* save;
    yield* shown('This prefix is taken.');
    expect(invalid('Prefix')).toBe('true');
    expect(invalid('Name')).toBeNull();
    yield* save;
    yield* shown('This prefix is taken.');
    expect(sent.map(({ payload }) => payload.name)).toEqual(['Apollo', 'Apollo']);
    expect(sent[0]?.key).toBe(sent[1]?.key);
    expect(sent[0]?.payload.note).toEqual(Option.none());
  }),
);

it.effect('shows a refusal without a field as the form-level error and a new payload gets a new key', () =>
  Effect.gen(function* formRefusal() {
    render(<RenameProjectForm />);
    yield* type('Name', 'Apollo');
    yield* type('Prefix', 'DOWN');
    yield* type('Note', 'moved');
    yield* save;
    yield* shown('Try again later.');
    expect(invalid('Prefix')).toBeNull();
    yield* Effect.promise(() => user().clear(screen.getByLabelText('Prefix')));
    yield* type('Prefix', 'APL');
    expect(screen.queryByText('Try again later.')).toBeNull();
    yield* save;
    expect(sent.length).toBe(2);
    expect(sent[1]?.key).not.toBe(sent[0]?.key);
    expect(sent[1]?.payload.note).toEqual(Option.some('moved'));
  }),
);

/** A payload with a check on the whole struct: the two values must match. */
const ChangeSecretPayload = Schema.Struct({ confirmation: Schema.String, secret: Schema.String }).check(
  Schema.makeFilter(({ confirmation, secret }) =>
    confirmation === secret ? undefined : { issue: 'form.confirmation.mismatch', path: ['confirmation'] },
  ),
);
const changed: string[] = [];
const changeSecretForm = FormReact.make(fromPayload(ChangeSecretPayload), {
  fields: { confirmation: TextField, secret: TextField },
  onSubmit: (_submit, { decoded }) => Effect.sync(() => changed.push(decoded.secret)),
});
const secretLabels = { confirmation: 'Confirmation', secret: 'Secret' } as const;

it.effect('runs the payload check on the whole struct and reports it on the field it names', () =>
  Effect.gen(function* structCheck() {
    render(
      <RegistryProvider>
        <FormRoot
          defaultValues={{ confirmation: '', secret: '' }}
          form={changeSecretForm}
          translateMessage={(message) => (message === 'form.confirmation.mismatch' ? 'The values differ.' : message)}
        >
          <changeSecretForm.secret label={secretLabels.secret} />
          <changeSecretForm.confirmation label={secretLabels.confirmation} />
          <SubmitButton>Save</SubmitButton>
        </FormRoot>
      </RegistryProvider>,
    );
    yield* type(secretLabels.secret, 'alpha');
    yield* type(secretLabels.confirmation, 'beta');
    yield* save;
    yield* shown('The values differ.');
    expect(invalid(secretLabels.confirmation)).toBe('true');
    expect(changed).toEqual([]);
  }),
);

/** A payload whose whole-struct check names no field: its failure is the form-level error. */
const MatchingPayload = Schema.Struct({ first: Schema.String, second: Schema.String }).check(
  Schema.makeFilter(({ first, second }) => (first === second ? undefined : 'form.values.differ')),
);
const matchingForm = FormReact.make(fromPayload(MatchingPayload), {
  fields: { first: TextField, second: TextField },
  mode: { validation: 'onChange' },
  onSubmit: () => Effect.void,
});
const matchingLabels = { first: 'First', second: 'Second' } as const;

const ValidateButton = () => {
  const validate = useAtomSet(matchingForm.validate);
  return (
    <Button onClick={() => validate()} type="button">
      Validate
    </Button>
  );
};

it.effect('shows a form-level error for the values it checked, and again after an explicit validation', () =>
  Effect.gen(function* rootValidation() {
    render(
      <RegistryProvider>
        <FormRoot
          defaultValues={{ first: '', second: '' }}
          form={matchingForm}
          translateMessage={(message) => (message === 'form.values.differ' ? 'The values differ.' : message)}
        >
          <matchingForm.first label={matchingLabels.first} />
          <matchingForm.second label={matchingLabels.second} />
          <FormRootError form={matchingForm} />
          <ValidateButton />
          <SubmitButton>Save</SubmitButton>
        </FormRoot>
      </RegistryProvider>,
    );
    yield* type(matchingLabels.first, 'alpha');
    yield* type(matchingLabels.second, 'beta');
    yield* save;
    yield* shown('The values differ.');
    yield* type(matchingLabels.second, 'x');
    expect(screen.queryByText('The values differ.')).toBeNull();
    yield* Effect.promise(() => user().click(screen.getByRole('button', { name: 'Validate' })));
    yield* shown('The values differ.');
    yield* Effect.promise(() => user().clear(screen.getByLabelText(matchingLabels.second)));
    yield* type(matchingLabels.second, 'alpha');
    expect(screen.queryByText('The values differ.')).toBeNull();
  }),
);

/** A whole-form check that waits on the test before it answers, like a server-side validation. */
const release = Deferred.makeUnsafe<boolean>();
const slowForm = FormReact.make(
  FormBuilder.empty
    .addField('code', Schema.String)
    .refineEffect(({ code }) =>
      Deferred.await(release).pipe(Effect.as(code === 'taken' ? { issue: 'form.code.taken', path: [] } : undefined)),
    ),
  { fields: { code: TextField }, onSubmit: () => Effect.void },
);
const SlowValidate = () => {
  const validate = useAtomSet(slowForm.validate);
  return (
    <Button onClick={() => validate()} type="button">
      Validate
    </Button>
  );
};
const codeLabel = { code: 'Code' } as const;

it.effect('keeps the values still while a slow whole-form check runs, so its error describes them', () =>
  Effect.gen(function* slowValidation() {
    render(
      <RegistryProvider>
        <FormRoot
          defaultValues={{ code: '' }}
          form={slowForm}
          translateMessage={(message) => (message === 'form.code.taken' ? 'This code is taken.' : message)}
        >
          <slowForm.code label={codeLabel.code} />
          <FormRootError form={slowForm} />
          <SlowValidate />
        </FormRoot>
      </RegistryProvider>,
    );
    yield* type(codeLabel.code, 'taken');
    yield* Effect.promise(() => user().click(screen.getByRole('button', { name: 'Validate' })));
    const input = screen.getByLabelText(codeLabel.code);
    expect(input.hasAttribute('disabled')).toBe(true);
    yield* type(codeLabel.code, 'x');
    expect(input.getAttribute('value')).toBe('taken');
    yield* Deferred.succeed(release, true);
    yield* shown('This code is taken.');
    expect(screen.getByLabelText(codeLabel.code).hasAttribute('disabled')).toBe(false);
  }),
);
