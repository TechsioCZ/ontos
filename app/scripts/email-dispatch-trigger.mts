// Stage-only by deployment configuration: the Node host triggers the Shell's EMAIL-bound dispatcher.
// It never receives message content, DB credentials for mail, or a transport fallback.
export const startEmailDispatchTrigger = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): (() => void) => {
  const configuredUrl = environment['ONTOS_EMAIL_DISPATCH_URL'];
  const secret = environment['ONTOS_EMAIL_DISPATCH_SECRET'];
  if (configuredUrl === undefined && secret === undefined) return () => {};
  const url = configuredUrl === undefined || !URL.canParse(configuredUrl) ? null : new URL(configuredUrl);
  if (
    url === null ||
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/shell-super-app-api/email/dispatch' ||
    secret === undefined ||
    secret.trim() === ''
  ) {
    throw new Error(
      'ONTOS_EMAIL_DISPATCH_URL (HTTPS Shell dispatch endpoint) and ONTOS_EMAIL_DISPATCH_SECRET must be configured together',
    );
  }
  const abort = new AbortController();
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight || abort.signal.aborted) return;
    inFlight = true;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
        redirect: 'error',
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
      });
      // Consume only a small JSON acknowledgement; never log credentials or upstream error bodies.
      await response.body?.cancel();
      if (!response.ok) console.error(`[email-trigger] dispatch HTTP ${response.status}`);
    } catch {
      if (!abort.signal.aborted) console.error('[email-trigger] dispatch unavailable');
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 10_000);
  timer.unref();
  const stop = (): void => {
    clearInterval(timer);
    abort.abort();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  void tick();
  return stop;
};
