// expect-count: 3
import { Effect } from "effect";

export const loadDashboard = (tenantId: string) =>
	Effect.gen(function* () {
		yield* Effect.log(tenantId);
	});

/** A plain JSX component is not an Effect operation. */
export const Panel = (props: { readonly title: string }) => <section>{props.title}</section>;

export const submitForm = (form: { readonly name: string }, aborted: boolean) => {
	const name = form.name;
	return Effect.gen(function* () {
		yield* Effect.log(`${name}:${String(aborted)}`);
	});
};

const handlers = {
	["restore"]: (id: string) =>
		Effect.gen(function* () {
			yield* Effect.log(id);
		}),
};

export default handlers;
