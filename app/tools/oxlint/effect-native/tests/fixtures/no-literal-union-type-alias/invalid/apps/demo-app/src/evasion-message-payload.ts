// expect-count: 4
// Literal text is interpolated verbatim into the diagnostic message: escapes, quotes,
// message-template placeholders and non-ASCII members must not corrupt or crash the report.
export type ControlChars = '\n' | '\t' | '\r';

export type Quoted = "it's" | 'say "hi"' | '`tick`';

export type Templated = '{{name}}' | '{{owner}}' | '{{members}}';

export type Unicode = 'zákazník' | 'dodavatel' | 'oné';
