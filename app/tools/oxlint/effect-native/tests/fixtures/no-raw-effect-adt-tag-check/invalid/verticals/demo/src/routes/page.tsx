// expect-count: 2
import { Result } from 'effect';

export function Row(props: { readonly outcome: Result.Result<string, Error> }) {
	const label = props.outcome._tag === 'Failure' ? 'error' : 'ok';
	return <span data-ok={props.outcome._tag === 'Success'}>{label}</span>;
}
