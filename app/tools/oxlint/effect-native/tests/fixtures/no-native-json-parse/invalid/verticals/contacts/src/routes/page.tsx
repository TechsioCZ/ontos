// expect-count: 2
declare const props: { readonly payload: string };

export function Page() {
	const model = JSON.parse(props.payload) as { readonly title: string };
	const tags: readonly string[] = props.payload.split("|").map(JSON.parse);
	return <section title={model.title}>{tags.length}</section>;
}
