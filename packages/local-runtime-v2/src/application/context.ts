import type { ProcessLocalContext } from "@mavis/conversation-contract";

/** Transport-neutral context accepted by local-runtime-v2 Application use cases. */
export interface ApplicationContext extends ProcessLocalContext {}
