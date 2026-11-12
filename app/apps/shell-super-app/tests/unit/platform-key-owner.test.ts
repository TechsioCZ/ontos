import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import { PLATFORM_KEY_OWNER, refusePlatformKeyOwnerSession } from '../../api/auth/platform-key-owner.ts';

it.effect('refuses a session for the platform key owner and lets every other user on to principal resolution', () =>
  Effect.gen(function* sessionGuard() {
    const refused = yield* Effect.exit(refusePlatformKeyOwnerSession(PLATFORM_KEY_OWNER.id, () => 'refused' as const));
    expect(Exit.isFailure(refused)).toBe(true);
    const admitted = yield* Effect.exit(refusePlatformKeyOwnerSession('ordinary-user', () => 'refused' as const));
    expect(Exit.isSuccess(admitted)).toBe(true);
  }),
);
