// A8: JSX text and attribute strings that merely spell a console call are generated text.
export const view = (): unknown => (
	<div title="console.log('x')">
		console.log(&quot;x&quot;) process.stdout.write(&quot;y&quot;)
	</div>
);
