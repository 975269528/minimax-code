import type { SessionQueryService } from "../../service/session-system/index.js";
import type { toSessionInfoView, toSessionTreeChildView } from "./wire.js";

/** Query parameters come only from the local Session service; callers cannot supply tenant, account, or RPC metadata. */
type QueryInput<Method extends "list" | "search" | "tree" | "sidebarTree"> =
  NonNullable<Parameters<SessionQueryService[Method]>[0]>;

export type ListSessionsInput = Pick<
  QueryInput<"list">,
  | "limit"
  | "offset"
  | "cursor"
  | "includeArchived"
  | "onlyArchived"
  | "onlyCompressed"
  | "includeHidden"
  | "includePurposePrefix"
  | "excludePurposePrefix"
> & { readonly name: string };
export type SessionTreeInput = Omit<ListSessionsInput, "offset">;
export interface SessionLookupInput {
  readonly id: string;
}
export type SearchSessionsInput = QueryInput<"search">;
export type SessionPage = {
  readonly sessions: ReturnType<typeof toSessionInfoView>[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
};
export type SessionTreePage = {
  readonly sessions: {
    readonly session: ReturnType<typeof toSessionInfoView>;
    readonly childSessions: ReturnType<typeof toSessionTreeChildView>[];
  }[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
};
export type SessionLookupResult = {
  readonly session: ReturnType<typeof toSessionInfoView>;
};
