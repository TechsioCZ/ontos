// expect-count: 2
// TSX + the Modern.js BFF barrel that re-exports Effect's `Schema` verbatim.
import { pipe, Schema } from '@modern-js/plugin-bff/effect-client';

const ContactFormSchema = Schema.Struct({ email: Schema.String });

export const decodeForm = (raw: unknown): { readonly email: string } =>
	pipe(raw, Schema.decodeUnknownSync(ContactFormSchema));

export const ContactEmail = ({ raw }: { readonly raw: unknown }): JSX.Element => (
	<span>{Schema.decodeUnknownSync(ContactFormSchema)(raw).email}</span>
);
