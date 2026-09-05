import { Option } from 'effect';

type Row = { readonly _tag: 'Draft' | 'Published'; readonly title: string };

const List = <T extends Row>({ rows, render }: { readonly rows: readonly T[]; readonly render: (row: T) => string }) => (
	<>
		{rows.map((row) => (
			<li data-draft={row._tag === 'Draft'} key={row.title}>
				{render(row)}
			</li>
		))}
	</>
);

export function Page({ rows, user }: { readonly rows: readonly Row[]; readonly user: Option.Option<string> }) {
	const name = Option.getOrElse(user, () => 'anonymous');
	return (
		<main {...{ 'data-name': name }}>
			<List render={(row) => `${row._tag}:${row.title}`} rows={rows} />
			{Option.isSome(user) ? <b>{user.value}</b> : <em>{name}</em>}
		</main>
	);
}
