import { Schema } from "effect";

const Payload = Schema.Struct({ title: Schema.String });
const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(Payload));

declare const Ctx: { readonly Provider: (props: { readonly value: unknown }) => unknown };
declare const parse: (text: string) => unknown;

export function Panel(props: { readonly text: string }) {
	return (
		<article data-encoded={JSON.stringify(props.text)}>
			<Ctx.Provider value={{ parse }} />
			<svg xmlns:xlink="http://www.w3.org/1999/xlink" />
			{decodePayload.name}
		</article>
	);
}
