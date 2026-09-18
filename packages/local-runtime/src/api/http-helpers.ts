import type { RespData } from '@mavis/agent-core/protocol/agent-message';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: { ...JSON_HEADERS, ...(init?.headers ?? {}) },
  });
}

export function notFound(pathname: string): Response {
  return json({ error: `Local runtime route not found: ${pathname}` }, { status: 404 });
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = (await request.json()) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readFirstString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

export function parseRespData(raw: string): RespData | undefined {
  try {
    const parsed = JSON.parse(raw) as RespData;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}
