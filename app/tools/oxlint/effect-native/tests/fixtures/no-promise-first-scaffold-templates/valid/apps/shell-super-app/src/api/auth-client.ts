/** Hand-written application source is out of scope here: A9's own rules own these seams, not this one. */
import { Effect } from 'effect';

export const signIn = async (email: string) => {
	const response = await fetch('/api/auth/sign-in', { method: 'POST', body: email });
	return Effect.runPromise(decodeSession(response)).then((session) => session.token);
};
