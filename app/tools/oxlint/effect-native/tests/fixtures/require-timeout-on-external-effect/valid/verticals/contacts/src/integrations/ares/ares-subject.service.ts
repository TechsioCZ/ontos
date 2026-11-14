// The blessed ARES adapter shape the audit names under "Existing patterns to preserve".
import { Cause, Effect, Schedule } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

const ARES_REQUEST_TIMEOUT = '3 seconds';
const retrySchedule = Schedule.exponential('100 millis');
const isRetryable = (error: Error) => error.message === 'unavailable';

const requestSubject = (httpClient: HttpClient.HttpClient, ico: string) => {
  const request = HttpClientRequest.get(`https://ares.test/${ico}`, { acceptJson: true });
  return httpClient.execute(request).pipe(
    Effect.timeout(ARES_REQUEST_TIMEOUT),
    Effect.tapCause((cause) => Effect.logError('ARES subject request failed', Cause.pretty(cause))),
  );
};

export const lookup = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  return yield* requestSubject(httpClient, '48039101').pipe(
    Effect.retry({ schedule: retrySchedule, while: isRetryable }),
  );
});

export const timedOutOrElse = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  return yield* client.get('https://ares.test/health').pipe(
    Effect.timeoutOrElse({ duration: '1 second', onTimeout: () => Effect.succeed('unknown') }),
  );
});
