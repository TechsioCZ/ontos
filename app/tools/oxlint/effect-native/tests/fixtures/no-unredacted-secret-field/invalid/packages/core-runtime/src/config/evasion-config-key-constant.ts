// expect-count: 1
// Evasion: centralising env key names in a `const` hides the literal from the CallExpression check.
import { Config } from 'effect';

const AUTH_SECRET_KEY = 'BETTER_AUTH_SECRET';

export const AuthSecret = Config.string(AUTH_SECRET_KEY);
