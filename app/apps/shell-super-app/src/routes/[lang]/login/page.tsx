import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { toaster } from '@techsio/ui-kit/molecules/toast';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { authClient } from '../../../auth/auth-client';

const supportedLanguages = new Set(['en', 'cs']);
type Language = 'en' | 'cs';

const normalizeLanguage = (language: string): Language =>
  supportedLanguages.has(language) ? (language as Language) : 'en';

export default function LoginPage() {
  const { language, t } = useModernI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const session = authClient.useSession();
  const user = session.data?.user;
  const lang = normalizeLanguage(language);
  const homePath = `/${lang}`;

  useEffect(() => {
    if (user !== undefined && user !== null) {
      window.location.replace(homePath);
    }
  }, [homePath, user]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);

    void authClient.signIn
      .email({
        email,
        password,
      })
      .then((result) => {
        if (result.error !== null) {
          toaster.create({
            description: t('auth.loginFailedDescription'),
            title: t('auth.loginFailedTitle'),
            type: 'error',
          });
          return;
        }

        window.location.assign(homePath);
      })
      .catch(() => {
        toaster.create({
          description: t('auth.loginFailedDescription'),
          title: t('auth.loginFailedTitle'),
          type: 'error',
        });
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  };

  return (
    <main className="min-h-screen bg-[var(--ui-color-bg-canvas)] text-[var(--ui-color-text)]">
      <section className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 py-12">
        <div className="space-y-8">
          <div className="space-y-3">
            <Link href={homePath}>{t('auth.backHome')}</Link>
            <h1 className="text-3xl font-semibold tracking-normal text-[var(--ui-color-text-strong)]">
              {t('auth.loginTitle')}
            </h1>
          </div>

          <form className="space-y-5" onSubmit={handleSubmit}>
            <FormInput
              autoComplete="email"
              id="login-email"
              label={t('auth.emailLabel')}
              onChange={(event) => setEmail(event.currentTarget.value)}
              required
              type="email"
              value={email}
            />
            <FormInput
              autoComplete="current-password"
              id="login-password"
              label={t('auth.passwordLabel')}
              onChange={(event) => setPassword(event.currentTarget.value)}
              required
              type="password"
              value={password}
            />
            <Button
              block
              isLoading={isSubmitting}
              loadingText={t('auth.loginSubmitting')}
              type="submit"
            >
              {t('auth.loginSubmit')}
            </Button>
          </form>
        </div>
      </section>
    </main>
  );
}
