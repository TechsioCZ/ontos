/** No Effect import: a `Success` tag here is not evidence of an Effect ADT (requireEffectImport). */
type UploadState = { readonly _tag: 'Success'; readonly url: string } | { readonly _tag: 'Failure' };

export function Upload(props: { readonly state: UploadState }) {
	return <span>{props.state._tag === 'Success' ? props.state.url : 'failed'}</span>;
}
