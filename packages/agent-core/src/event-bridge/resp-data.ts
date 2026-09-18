import type { RespData } from '../protocol/agent-message.js';
import type { PiTurnRunnerLogger } from '../pi-turn-runner/types.js';

export type RespDataTransform = (
  respData: RespData,
  ctx: RespDataTransformContext,
) => Promise<RespData> | RespData;

export interface RespDataTransformContext {
  sessionId: string;
  turnId: string;
}

export async function applyRespDataTransform(
  transform: RespDataTransform | undefined,
  respData: RespData,
  ctx: RespDataTransformContext,
  logger?: PiTurnRunnerLogger,
): Promise<RespData> {
  if (!transform) return respData;
  try {
    return await transform(respData, ctx);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger?.warn?.(
      { session_id: ctx.sessionId, turn_id: ctx.turnId, error: reason },
      'respDataTransform failed; using original RespData',
    );
    return respData;
  }
}
