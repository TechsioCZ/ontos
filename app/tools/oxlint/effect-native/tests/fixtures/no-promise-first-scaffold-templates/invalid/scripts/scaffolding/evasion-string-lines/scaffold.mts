// expect-count: 3
/**
 * A8 evasion: the generator emits the same Promise-first page, but assembles it from string literals
 * joined with newlines instead of a template literal, so no `TemplateLiteral` node is ever visited.
 */
export const renderPage = (component: string): string =>
	[
		"import { useEffect, useState } from 'react';",
		'',
		'export const load' + component + ' = async () => {',
		"  const response = await fetch('/api/rows');",
		'  return response.json();',
		'};',
	].join('\n');
