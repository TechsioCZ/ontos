import { Effect } from 'effect';

declare const submit: (value: string) => Effect.Effect<void>;

/** Browser code is A9 territory, handled by the browser runtime rule, never by this one. */
export function Form(): unknown {
	const onSubmit = (value: string): void => {
		void Effect.runPromise(submit(value));
	};
	return <button onClick={() => onSubmit('x')}>save</button>;
}
