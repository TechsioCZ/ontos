import { Effect, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';

const PasswordSetSchema = Schema.Struct({ status: Schema.Literal(true) });
export const InvitationTokenSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u));
export const InvitationPasswordSchema = Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(128));

/** Browser-only adapter to the same native Better Auth reset endpoint used by the mail invitation. */
export const setInvitationPassword = Effect.fn('setInvitationPassword')(
  function* setInvitationPassword(token: string, password: Redacted.Redacted) {
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post('/shell-super-app-api/invitation/set-password'),
      { password: Redacted.value(password), token },
    );
    const response = yield* client.execute(request);
    if (response.status !== 200) {
      return {
        message:
          response.status === 400
            ? 'Pozvánka už není platná nebo heslo nesplňuje podmínky. Požádejte správce o novou pozvánku.'
            : 'Heslo se nepodařilo nastavit. Zkuste to znovu.',
        status: 'failed',
      } as const;
    }
    yield* Schema.decodeUnknownEffect(PasswordSetSchema)(yield* response.json);
    return { status: 'ok' } as const;
  },
  Effect.timeout('30 seconds'),
  Effect.orElseSucceed(
    () =>
      ({
        message:
          'Výsledek nastavení hesla nelze ověřit. Zkuste se přihlásit; pokud to nejde, požádejte správce o novou pozvánku.',
        status: 'failed',
      }) as const,
  ),
);
