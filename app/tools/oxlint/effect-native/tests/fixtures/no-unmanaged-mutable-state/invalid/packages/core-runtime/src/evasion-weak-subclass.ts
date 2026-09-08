// expect-count: 2
// Evasion: subclassing the weak collection hides the constructor name from the `new` site.
// `causes` is still an identity-keyed cause channel beside the typed error (audit A4).
class CauseChannel extends WeakMap<Error, unknown> {}
class TrustedContexts extends WeakSet<object> {}

export const causes = new CauseChannel();
export const trusted = new TrustedContexts();

export const remember = (error: Error, cause: unknown): void => {
	causes.set(error, cause);
};

export const isTrusted = (context: object): boolean => trusted.has(context);
