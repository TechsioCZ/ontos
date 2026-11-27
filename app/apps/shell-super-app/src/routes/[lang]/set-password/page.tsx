import { requiredLabelFor } from '@app/admin-ui';
import {
  FormBuilder,
  FormReact,
  FormRoot,
  FormRootError,
  SubmitButton,
  TextField,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Option, Redacted, Schema } from 'effect';
import { AsyncResult } from 'effect/reactivity';

import { browserAtomRuntime } from '../../../runtime/browser-effect-runtime.ts';
import {
  InvitationPasswordSchema,
  InvitationTokenSchema,
  setInvitationPassword,
} from '../../people/invitation-client.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

const SearchSchema = Schema.Struct({ token: InvitationTokenSchema });
/** The password the invitation endpoint accepts, refused in the page's own words. */
const PasswordSchema = Schema.String.check(
  Schema.makeFilter(Schema.is(InvitationPasswordSchema), { message: 'Zvolte heslo o délce 8 až 128 znaků.' }),
);

/** The invitation endpoint refused the password or its answer could not be read; `reason` is the Czech copy. */
class PasswordNotSet extends Schema.TaggedError<PasswordNotSet>()('PasswordNotSet', { reason: Schema.String }) {}

/**
 * The one-use invitation token from the link and the password typed twice. The password is redacted once
 * decoded; a refusal is the form's own error, shown until the next attempt. The invitation copy is Czech only.
 */
const setPasswordForm = FormReact.make(
  FormBuilder.empty
    .addField('confirmation', Schema.String)
    .addField('password', Schema.RedactedFromValue(PasswordSchema))
    .addField('token', InvitationTokenSchema)
    .refine(
      ({ confirmation, password }) =>
        confirmation === Redacted.value(password) || { issue: 'Hesla se neshodují.', path: ['confirmation'] },
    ),
  {
    fields: { confirmation: TextField, password: TextField, token: TextField },
    // Once the password is set, the one-use secret does not stay in the navigation history.
    onSubmit: (_submit, { decoded }) =>
      setInvitationPassword(decoded.token, decoded.password).pipe(
        Effect.flatMap((outcome) =>
          outcome.status === 'failed'
            ? Effect.fail(new PasswordNotSet({ reason: outcome.message }))
            : Effect.sync(() => window.history.replaceState(window.history.state, '', window.location.pathname)),
        ),
      ),
    runtime: browserAtomRuntime,
    submitErrors: ({ reason }) => [{ message: reason, path: '' as const }],
  },
);

const untranslated = (message: string) => message;

const SetPasswordPage = () => {
  const { language, t } = useModernI18n();
  const token = useRouterState({
    select: (state) => Option.getOrUndefined(Schema.decodeUnknownOption(SearchSchema)(state.location.search))?.token,
  });
  const submitted = useAtomValue(setPasswordForm.submit);
  const done = AsyncResult.isSuccess(submitted) && !submitted.waiting;
  const requiredLabel = requiredLabelFor(language);
  return (
    <>
      <UltramodernRouteHead />
      <meta content="no-referrer" name="referrer" />
      <main className="flex min-h-dvh items-center justify-center bg-surface p-300 text-fg-primary">
        <section className="grid w-full max-w-md gap-200 rounded-lg border border-border-primary bg-base p-300">
          <h1 className="font-semibold text-xl">Nastavit heslo k přihlášení</h1>
          {done && (
            <>
              <StatusText status="success">
                Heslo je nastavené. Nyní se přihlaste svým e-mailem. Přístup do firmy a role určuje správce.
              </StatusText>
              <Link href={`/${language}/login`}>Přejít na přihlášení</Link>
            </>
          )}
          {!done && token === undefined && (
            <StatusText role="alert" status="error">
              Odkaz pozvánky není platný. Otevřete celý odkaz z e-mailu nebo požádejte správce o novou pozvánku.
            </StatusText>
          )}
          {!done && token !== undefined && (
            <>
              <p>
                Zvolte vlastní heslo. Tento jednorázový odkaz nikomu nepřeposílejte. Nastavení hesla nepřiděluje role
                ani neaktivuje členství ve firmě.
              </p>
              {/* The fields render once the form starts in the browser, so the server render holds nothing to post. */}
              <FormRoot
                className="grid gap-200"
                defaultValues={{ confirmation: '', password: '', token }}
                form={setPasswordForm}
                key={token}
                translateMessage={untranslated}
              >
                <setPasswordForm.password
                  autoComplete="new-password"
                  label={t('shell.invitation.newPassword')}
                  maxLength={128}
                  minLength={8}
                  required
                  requiredLabel={requiredLabel}
                  type="password"
                />
                <setPasswordForm.confirmation
                  autoComplete="new-password"
                  label={t('shell.invitation.confirmPassword')}
                  maxLength={128}
                  minLength={8}
                  required
                  requiredLabel={requiredLabel}
                  type="password"
                />
                <FormRootError form={setPasswordForm} />
                <SubmitButton loadingText="Nastavuji heslo…" severity="primary">
                  Nastavit heslo
                </SubmitButton>
              </FormRoot>
            </>
          )}
        </section>
      </main>
    </>
  );
};
export default SetPasswordPage;
