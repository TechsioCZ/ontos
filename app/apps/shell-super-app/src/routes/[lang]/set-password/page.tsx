import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Effect, Option, Redacted, Schema } from 'effect';
import { useState } from 'react';

import { browserRuntime } from '../../../runtime/browser-effect-runtime.ts';
import {
  InvitationPasswordSchema,
  InvitationTokenSchema,
  setInvitationPassword,
} from '../../people/invitation-client.ts';
import { UltramodernRouteHead } from '../../ultramodern-route-head';

const SearchSchema = Schema.Struct({ token: InvitationTokenSchema });
const SetPasswordPage = () => {
  const { language, t } = useModernI18n();
  const token = useRouterState({
    select: (state) => Option.getOrUndefined(Schema.decodeUnknownOption(SearchSchema)(state.location.search))?.token,
  });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const submit = (form: FormData) => {
    if (busy || done || token === undefined) {
      return;
    }
    const password = Schema.decodeUnknownOption(InvitationPasswordSchema)(form.get('password'));
    if (Option.isNone(password)) {
      setError('Zvolte heslo o délce 8 až 128 znaků.');
      return;
    }
    if (form.get('confirmation') !== password.value) {
      setError('Hesla se neshodují.');
      return;
    }
    setBusy(true);
    setError('');
    void browserRuntime.runPromise(
      setInvitationPassword(token, Redacted.make(password.value)).pipe(
        Effect.andThen((outcome) =>
          Effect.sync(() => {
            setBusy(false);
            if (outcome.status === 'failed') {
              setError(outcome.message);
              return;
            }
            setDone(true);
            // Do not retain the one-use secret in navigation history after successful consumption.
            window.history.replaceState(window.history.state, '', window.location.pathname);
          }),
        ),
      ),
    );
  };
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
            <form action={submit} className="grid gap-200">
              <p>
                Zvolte vlastní heslo. Tento jednorázový odkaz nikomu nepřeposílejte. Nastavení hesla nepřiděluje role
                ani neaktivuje členství ve firmě.
              </p>
              <FormInput
                autoComplete="new-password"
                disabled={busy}
                label={t('shell.invitation.newPassword')}
                maxLength={128}
                minLength={8}
                name="password"
                required
                type="password"
              />
              <FormInput
                autoComplete="new-password"
                disabled={busy}
                label={t('shell.invitation.confirmPassword')}
                maxLength={128}
                minLength={8}
                name="confirmation"
                required
                type="password"
              />
              {error === '' ? null : (
                <StatusText role="alert" status="error">
                  {error}
                </StatusText>
              )}
              <Button disabled={busy} type="submit" variant="primary">
                {busy ? 'Nastavuji heslo…' : 'Nastavit heslo'}
              </Button>
            </form>
          )}
        </section>
      </main>
    </>
  );
};
export default SetPasswordPage;
