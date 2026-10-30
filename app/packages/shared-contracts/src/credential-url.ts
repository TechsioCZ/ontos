import { Result } from 'effect';

// OAuth authorization codes and invitation tokens are legitimate query inputs, not passwords.
const credentialKey =
  /password|passwd|pwd|secret|credential|api[-_]?key|^(?:access_token|refresh_token|id_token|authorization|confirmation)$/iu;
const authPage = /^\/(?:cs|en)\/(?:login|set-password|pripojit|connect)(?:\/|$)/u;
const RETURN_ORIGIN = 'https://return.invalid';
const decodePath = (value: string) => Result.getOrUndefined(Result.try(() => decodeURIComponent(value)));
const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point < 32 || point === 127) {
      return true;
    }
  }
  return false;
};

/** URLSearchParams decodes escaped names before they are compared, including repeated keys. */
export const hasCredentialQuery = (url: URL, depth = 0): boolean => {
  for (const [key, value] of url.searchParams) {
    if (credentialKey.test(key)) {
      return true;
    }
    if (key.toLowerCase() === 'returnto') {
      const nested = Result.getOrUndefined(Result.try(() => new URL(value, RETURN_ORIGIN)));
      if (depth >= 4 || nested === undefined || hasCredentialQuery(nested, depth + 1)) {
        return true;
      }
    }
  }
  return false;
};

export const isAuthenticationPath = (pathname: string): boolean =>
  authPage.test(pathname) || /^\/(?:shell-super-app-api\/)?(?:auth|oauth|mcp)(?:\/|$)/u.test(pathname);

/** Never carry the submitted URL, its query, or the POST body into the rejection redirect. */
export const credentialSubmissionRedirect = (url: URL, method: string): string | undefined => {
  const nativePost = method === 'POST' && /^\/(?:cs|en)\/(?:login|set-password)\/?$/u.test(url.pathname);
  if (!nativePost && !hasCredentialQuery(url)) {
    return undefined;
  }
  const language = url.pathname.split('/')[1] === 'en' ? 'en' : 'cs';
  return `/${language}/login`;
};

/** Auth queries include signed OAuth state and one-use tokens, so redact every value, not just passwords. */
export const authenticationQueryRedactions: readonly RegExp[] = [/./u];

/** Reject browser URL normalization tricks, encoded source code and credentials before saving a return path. */
export const isSafeSignInReturnPath = (path: string, language: string): boolean => {
  if (!/^(?:cs|en)$/u.test(language) || !path.startsWith(`/${language}/`)) {
    return false;
  }
  let decoded = path;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = decodePath(decoded);
    if (next === undefined) {
      return false;
    }
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  const pathname = decoded.split(/[?#]/u)[0] ?? '';
  if (/%[\da-f]{2}|[\\<>{}"'` ]/iu.test(pathname) || decoded.includes('\\') || hasControlCharacter(decoded)) {
    return false;
  }
  const url = new URL(decoded, RETURN_ORIGIN);
  return (
    url.origin === RETURN_ORIGIN &&
    url.pathname.startsWith(`/${language}/`) &&
    !isAuthenticationPath(url.pathname) &&
    !hasCredentialQuery(url)
  );
};
