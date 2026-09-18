import type { Api, Model, StreamOptions } from "../types.ts";

/**
 * 把 provider 捕获到的原始异常同步交给宿主。宿主回调属于观测旁路，
 * 即使自身抛错也不能替换 provider 原本的失败结果。
 */
export function notifyProviderError(
	callback: StreamOptions["onProviderError"],
	error: unknown,
	model: Model<Api>,
): void {
	try {
		callback?.(error, model);
	} catch {
		// 错误观测失败不能影响 provider 的错误处理流程。
	}
}

/** Provider-event inspection is an observation side channel, never control flow. */
export async function* observeProviderEvents<T>(
	events: AsyncIterable<T>,
	callback: NonNullable<StreamOptions["onProviderStreamEvent"]>,
	model: Model<Api>,
): AsyncGenerator<T> {
	for await (const event of events) {
		try {
			callback(event, model);
		} catch {
			// 事件观测失败不能影响 provider stream。
		}
		yield event;
	}
}

/** Preserve the provider's original iterable when event inspection is disabled. */
export function withProviderEventObserver<T>(
	events: AsyncIterable<T>,
	callback: StreamOptions["onProviderStreamEvent"],
	model: Model<Api>,
): AsyncIterable<T> {
	return callback ? observeProviderEvents(events, callback, model) : events;
}
