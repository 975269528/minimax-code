import type { Api } from '@earendil-works/pi-ai';

import { DEFAULT_LOCAL_PI_API, lookupLocalModelLimits } from '../runtime/model-resolver.js';

/**
 * Resolve the pi-ai `api` for a legacy opencode assistant message.
 *
 * Opencode-native rows only persist `providerID` + `modelID`; opencode has
 * no `api` concept (see `nativeMessageFromRow` in
 * `legacy-opencode-store.ts`). Migrated assistant messages therefore land
 * with `api === undefined`, which breaks the outbound sibling/same-model
 * replay classifier (`normalizeAssistantMessage` in
 * `messages-count-tokens-messages.ts` / `outbound-message-normalizer.ts`):
 * `sameProviderAndApi` is `provider === target.provider && api ===
 * target.api`, so an undefined API forces EVERY
 * migrated thinking block down the cross-provider branch that wraps it in a
 * `<|prior-thinking|>…</|prior-thinking|>` text marker. After an upgrade the
 * model then sees that marker as a formatting example and starts leaking it
 * into its own visible output.
 *
 * The fix backfills `api` at migration time using the SAME source the live
 * target model uses to resolve its own `api`
 * (`LocalModelResolver.resolve`: `lookupLocalModelLimits(provider, model)
 * .api ?? DEFAULT_LOCAL_PI_API`). Because both sides derive `api` from the
 * pi-ai catalog with the identical fallback, same-provider upgrades
 * (same provider family) classify as same/sibling again and keep native
 * thinking replay instead of the text marker.
 *
 * Resolution order:
 *   1. pi-ai catalog (`lookupLocalModelLimits(provider, model).api`) —
 *      authoritative, same as the live resolver.
 *   2. provider-name prefix fallback — catalog can miss opencode-flavoured
 *      variant model ids. Map well-known provider families so legacy sessions
 *      do not get silently forced onto the Messages-compatible API.
 *   3. `DEFAULT_LOCAL_PI_API` (Messages-compatible API) — final fallback,
 *      matching the live resolver's `?? this.defaultApi` behaviour.
 */
export function resolveApiForLegacyProvider(provider: string, model?: string): Api | undefined {
  const normalizedProvider = provider.trim();
  if (!normalizedProvider) return undefined;

  const normalizedModel = model?.trim();
  if (normalizedModel) {
    const catalogApi = lookupLocalModelLimits(normalizedProvider, normalizedModel).api;
    if (catalogApi) return catalogApi;
  }

  const prefixApi = providerPrefixApi(normalizedProvider);
  if (prefixApi) return prefixApi;

  return DEFAULT_LOCAL_PI_API;
}

/**
 * Best-effort provider-family → api map for opencode providerIDs the pi-ai
 * catalog does not recognise. Kept deliberately small and prefix-based so it
 * tolerates opencode's provider naming variants (legacy provider families,
 * plus `minimax`, `minimax-cn`, `openai`, `openai-codex`,
 * `azure-openai`, `google`, `google-vertex`, `amazon-bedrock`, …). Returned
 * values are pi-ai `KnownApi` members (see `third_party/pi-mono/packages/ai/
 * src/types.ts`); `Api` itself is `KnownApi | (string & {})`, so the exact
 * spellings here must match the catalog's `api` field (e.g. OpenAI is
 * `openai-completions`, NOT `openai-chat`). The bedrock check precedes
 * minimax/provider checks so `amazon-bedrock` wins; the legacy-provider check
 * precedes google so the vertex variant stays on the Messages API. Anything unmatched
 * falls through to `DEFAULT_LOCAL_PI_API` at the call site.
 */
function providerPrefixApi(provider: string): Api | undefined {
  const lower = provider.toLowerCase();
  // Order matters: `amazon-bedrock` hosts MiniMax over the Bedrock Converse
  // API, so the bedrock check must precede the gateway/provider checks.
  if (lower.includes('bedrock')) return 'bedrock-converse-stream';
  // MiniMax's own gateways (`minimax`, `minimax-cn`, display name `MiniMax`)
  // speak the Messages-compatible protocol — see config.yaml provider
  // `minimax` (`npm: @ai-sdk/anthropic`) and the pi-ai catalog entries
  // (`MiniMax-M2.7` / `MiniMax-M3` → the Messages-compatible API). Other
  // hosts (opencode/openrouter → openai-completions) resolve via the
  // catalog lookup before this fallback ever runs.
  if (lower.includes('minimax') || lower.includes('MiniMax')) return 'anthropic-messages';
  if (lower.includes('anthropic') || lower.includes('claude')) return 'anthropic-messages';
  if (lower.includes('google') || lower.includes('gemini')) return 'google-generative-ai';
  if (lower.includes('openai') || lower.includes('azure')) return 'openai-completions';
  return undefined;
}
