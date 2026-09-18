import { stripVTControlCharacters } from 'node:util';
import { TranscriptView } from '../transcript/view.js';
import { createTranscriptCell, type TranscriptCellStatus } from '../transcript/model.js';

export type TuiToolGalleryState = 'running' | 'succeeded' | 'failed';

export interface TuiToolGalleryOptions {
  readonly width?: number;
  readonly plain?: boolean;
}

const STATES: readonly TuiToolGalleryState[] = ['running', 'succeeded', 'failed'];

const CASES = [
  { name: 'bash', content: '{"command":"pnpm test"}', detail: 'PASS 42 tests\nDone in 1.2s' },
  { name: 'read', content: '{"path":"src/app.ts"}', detail: 'export function start() {}' },
  { name: 'search', content: '{"query":"createSession"}', detail: 'src/session.ts:42' },
  { name: 'write', content: '{"path":"docs/report.md"}', detail: '# Capability report' },
  {
    name: 'edit',
    content: '{"path":"src/theme.ts"}',
    detail: 'Updated terminal theme tokens',
    structuredPreview: {
      schemaVersion: 1 as const,
      state: 'applied' as const,
      blocks: [
        {
          kind: 'diff' as const,
          path: 'src/theme.ts',
          diff: '- const line = oldColor\n+ const line = newColor',
          addedLines: 1,
          removedLines: 1,
          truncated: false,
        },
      ],
    },
  },
  { name: 'task', content: '{"description":"Review auth flow"}', detail: 'Agent reviewing files' },
  {
    name: 'mcp__matrix__web_search',
    content: '{"query":"terminal interaction patterns"}',
    detail: '3 sources returned',
  },
] as const;

export function renderTuiToolGallery(options: TuiToolGalleryOptions = {}): string {
  const width = Math.max(32, Math.floor(options.width ?? 80));
  const sections = STATES.flatMap((state) => [
    `TOOL LIFECYCLE · ${state.toLocaleUpperCase()}`,
    ...new TranscriptView(() => createGalleryCells(state)).render(width),
  ]);
  const rendered = sections.join('\n');
  return options.plain ? stripVTControlCharacters(rendered) : rendered;
}

export function createGalleryCells(state: TuiToolGalleryState) {
  const status: TranscriptCellStatus = state;
  return CASES.map((fixture, index) =>
    createTranscriptCell({
      id: `gallery:${state}:${fixture.name}`,
      kind: 'tool',
      status,
      title: fixture.name,
      content: fixture.content,
      detail: state === 'failed' ? `Failed: ${fixture.detail}` : fixture.detail,
      ...('structuredPreview' in fixture
        ? {
            structuredPreview: {
              ...fixture.structuredPreview,
              state:
                state === 'running' ? 'proposed' : state === 'failed' ? 'not-applied' : 'applied',
              blocks: [...fixture.structuredPreview.blocks],
            },
          }
        : {}),
      turnId: `gallery:${state}`,
      createdAtMs: index + 1,
      updatedAtMs: index + 1,
    }),
  );
}
