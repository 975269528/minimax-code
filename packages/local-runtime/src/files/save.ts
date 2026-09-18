/**
 * POST /api/file/save — write text content to a workspace file.
 *
 * Extracted from the main file API router (`api.ts`) to keep its
 * legacy-pinned line budget stable.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FileSaveHelpers {
  readJsonBody: (r: Request) => Promise<Record<string, unknown>>;
  resolveBodyPath: (b: Record<string, unknown>) => Promise<{ absolute: string } | Response>;
  readString: (d: Record<string, unknown>, k: string) => string | undefined;
  json: (d: unknown, init?: ResponseInit) => Response;
}

export async function routeFileSave(request: Request, h: FileSaveHelpers): Promise<Response> {
  const body = await h.readJsonBody(request);
  const target = await h.resolveBodyPath(body);
  if (target instanceof Response) return target;
  const content = h.readString(body, 'content');
  if (content === undefined) return h.json({ error: 'content is required' }, { status: 400 });
  try {
    await mkdir(dirname(target.absolute), { recursive: true });
    await writeFile(target.absolute, content, 'utf-8');
    return h.json({ ok: true });
  } catch (error) {
    return h.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 422 },
    );
  }
}
