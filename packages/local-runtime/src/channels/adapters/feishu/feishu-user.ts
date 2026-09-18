const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

export async function getFeishuUserDisplayName(input: {
  openId: string;
  fetcher: typeof fetch;
  ensureToken: () => Promise<string>;
  assertOkAndParse: (response: Response, method: string) => Promise<unknown>;
  cache: Map<string, string>;
}): Promise<string | undefined> {
  const id = input.openId.trim();
  if (!id) return undefined;
  const cached = input.cache.get(id);
  if (cached) return cached;
  const token = await input.ensureToken();
  const url = new URL(`${FEISHU_API_BASE}/contact/v3/users/${encodeURIComponent(id)}`);
  url.searchParams.set('user_id_type', 'open_id');
  const response = await input.fetcher(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await input.assertOkAndParse(response, 'getUserDisplayName')) as {
    data?: { user?: { name?: string; en_name?: string; nickname?: string } };
  };
  const user = body.data?.user;
  const name = user?.name?.trim() || user?.nickname?.trim() || user?.en_name?.trim();
  if (!name) return undefined;
  input.cache.set(id, name);
  return name;
}
