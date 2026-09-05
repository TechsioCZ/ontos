// Evasion: reach argv through a template-literal computed key. `process["argv"]` is handled;
// the tagless template form is not, even though the rule already resolves template literals for
// module specifiers.
const forwarded = process[`argv`].slice(2);
const mode = process[`argv`][2];

export { forwarded, mode };
