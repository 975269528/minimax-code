# MiniMax account, models, and media reference

Use this reference for MiniMax Code or MiniMax Open Platform accounts, Token Plan, subscription keys, credits/points/Credit, plans, usage, quotas, API keys, BYOK, providers, model catalogs and access, context windows, image/audio/music/video or multimodal entitlements, and why a model or media task is unavailable.

## Stable boundaries

- A Token Plan/subscription resource and pay-as-you-go API balance/API key are different resource paths; never assume their keys, quotas, or model access are interchangeable.
- Model availability depends on product surface, key/provider type, account, region, plan, version, and current service rollout—not the model name alone.
- Media support and credit eligibility are separate questions: a model may exist in the catalog without being enabled for the user's product, plan, or requested operation.
- The Agent cannot change balance, entitlement, quota, permissions, or server-side validation.

## Official source discovery

Use only the current region's sources:

- `region: cn` → MiniMax Code `https://agent.minimaxi.com/docs/llms.txt`; Open Platform `https://platform.minimaxi.com/docs/llms.txt`
- `region: en` → MiniMax Code `https://agent.minimax.io/docs/llms.txt`; Open Platform `https://platform.minimax.io/docs/llms.txt`

MiniMax Code docs are authoritative for product-surface behavior. Open Platform docs are authoritative for API models and underlying billing rules. Prefer `.md` pages discovered from the matching index. Never query both regional indexes for an ordinary current-region question.

## Verification workflow

1. Identify resource: subscription/Token Plan, purchased credits, pay-as-you-go balance, or BYOK provider.
2. Identify surface, region, model, media type, and requested operation.
3. Read the current regional official pages and specific model/API documentation; do not rely on historical model names, prices, quotas, or UI paths.
4. For account-specific state, tell the user where to inspect the console and mark balance/entitlement as unverified unless runtime/account evidence exists.
5. For “can credits generate video?” or similar, verify model operation support, product/plan eligibility, and current billing/credit rule.
6. Report the conclusion first, source links next, and unresolved account or rollout conditions last.

## Safety

Never expose or ask the user to paste API keys, subscription keys, passwords, OAuth secrets, or verification codes. Never promise that every model/media operation is covered by credits, or that a plan bypasses API billing. Do not bypass region, plan, account, or permission restrictions.
