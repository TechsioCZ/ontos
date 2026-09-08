// expect-count: 6
import type { Exit, Option } from 'effect';

type Props = { readonly outcome: Exit.Exit<string, Error>; readonly user: Option.Option<string> };

const render = <T,>(value: T, ok: boolean) => (ok ? <b>{String(value)}</b> : null);

export function Panel({ outcome, user }: Props) {
	const label = user._tag === 'Some' ? user.value : 'anonymous';
	return (
		<section className={user._tag === 'None' ? 'muted' : 'live'} data-failed={outcome._tag === 'Failure'}>
			<>{outcome._tag === 'Success' && <span>{label}</span>}</>
			{render(label, outcome?._tag !== 'Failure')}
			<em {...{ title: 'Failure' === outcome._tag ? 'bad' : 'good' }} />
		</section>
	);
}
