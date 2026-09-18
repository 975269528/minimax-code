import { SAFETY_CHECK_V2_SCENE, SafetyCheckV2Error } from '@mavis/shared/safety-check-v2';
import { callSafetyApi, SAFETY_SCENE, type SafetyCheckResult } from './api.js';
import { callLocalSafetyCheckV2 } from './api-v2.js';

/** V2 reviews input and every output stream; config retains its V1 contract. */
export async function callTurnSafetyApi(
  input: Parameters<typeof callSafetyApi>[0],
): Promise<SafetyCheckResult> {
  if (
    input.scene === SAFETY_SCENE.UserInput ||
    input.scene === SAFETY_SCENE.MessageOutput ||
    input.scene === SAFETY_SCENE.ThinkingContent ||
    input.scene === SAFETY_SCENE.StreamChunk
  ) {
    return reviewV2(input);
  }
  return callSafetyApi(input);
}

async function reviewV2(input: Parameters<typeof callSafetyApi>[0]): Promise<SafetyCheckResult> {
  if (!input.content.trim()) return { pass: true };
  try {
    const result = await callLocalSafetyCheckV2({
      ...input,
      request: {
        content_text: input.content,
        scene:
          input.scene === SAFETY_SCENE.UserInput
            ? SAFETY_CHECK_V2_SCENE.DesktopUserQuery
            : input.scene === SAFETY_SCENE.ThinkingContent
              ? SAFETY_CHECK_V2_SCENE.DesktopAssistantThinking
              : SAFETY_CHECK_V2_SCENE.DesktopAssistantReply,
      },
    });
    // An input guide without text is a pass; only output review uses SR fallback.
    if (
      input.scene === SAFETY_SCENE.UserInput &&
      result.action === 'guide' &&
      !result.guidePrompt?.trim()
    ) {
      return { pass: true, action: 'allow' };
    }
    return {
      pass: result.action === 'allow',
      action: result.action,
      ...(result.action !== 'allow' ? { errorKind: 'rejected' as const } : {}),
      ...(result.action === 'replace' ? { suggestion: result.replacementText } : {}),
      ...('guidePrompt' in result && result.guidePrompt
        ? { guide_prompt: result.guidePrompt }
        : {}),
    };
  } catch (error) {
    // No V2 verdict is fail-closed, including gateway 5xx; never retry through V1.
    return {
      pass: false,
      reason: 'Service unavailable',
      retryWithV2: true,
      errorKind:
        error instanceof SafetyCheckV2Error && error.kind === 'auth' ? 'auth_error' : 'local_error',
    };
  }
}
