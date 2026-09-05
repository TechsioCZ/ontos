import { Schema } from "effect";

const Contact = Schema.Struct({ name: Schema.String });
const decodeContact = Schema.decodeUnknownEffect(Schema.fromJsonString(Contact));

export function ContactCard(props: { readonly json: string }) {
	const label = JSON.stringify(props.json);
	return <article data-decoder={decodeContact.name}>{label}</article>;
}
