import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'effect-rstest';

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf-8');

const panelSource = readSource('../../src/routes/[lang]/prodej/prilezitosti/pipeline-detail-panel.tsx');
const pageSource = readSource('../../src/routes/[lang]/prodej/prilezitosti/page.tsx');

describe('opportunity quick view on the records list', () => {
  it('forwards the peek flag to both SidePanel wrappers of the detail panel', () => {
    expect(panelSource.match(/peek=\{peek\}/gu)?.length).toBe(2);
    expect(panelSource).toContain('readonly peek: boolean;');
  });

  it('opens the list detail panel as a non-blocking quick view', () => {
    const element = /<PipelineDetailPanel[\s\S]*?\/>/u.exec(pageSource)?.[0] ?? '';
    expect(element).toMatch(/^<PipelineDetailPanel[\s\S]*\bpeek\b/u);
  });
});
