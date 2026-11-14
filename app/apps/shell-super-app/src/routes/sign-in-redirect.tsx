import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useNavigate } from '@modern-js/plugin-tanstack/runtime';
import { LinkButton } from '@techsio/ui-kit/atoms/link-button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useEffect } from 'react';

import { signInHref } from './sign-in-return.ts';
import type { SignInReason } from './sign-in-return.ts';

/**
 * "Not signed in" on a protected page. Route loaders already redirect to sign-in (an HTTP redirect during server
 * rendering); this is the in-page fallback for a model that still arrives without a session. It goes to sign-in
 * with the page to return to and, when the session died, the reason; until then it says so, with a direct link.
 */
export const SignInRedirect = ({ reason }: { readonly reason?: SignInReason | undefined }) => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({
      href: signInHref(language, `${window.location.pathname}${window.location.search}`, reason),
      replace: true,
    });
  }, [language, navigate, reason]);
  return (
    <main className="shell:mx-auto shell:grid shell:w-full shell:max-w-5xl shell:justify-items-start shell:gap-4 shell:px-4 shell:py-8">
      <StatusText aria-live="polite" showIcon status="default">
        {t('shell.moduleTarget.sign_in_required')}
      </StatusText>
      <LinkButton href={`/${language}/login`} size="sm" theme="solid" variant="primary">
        {t('shell.auth.loginLink')}
      </LinkButton>
    </main>
  );
};
