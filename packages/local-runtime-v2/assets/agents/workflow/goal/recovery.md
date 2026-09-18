Goal recovery check: This Goal is resuming after a retracted Turn or Runtime recovery. The
conversation excerpt may be incomplete or stale.

- Before taking any other action, call get_goal and use its returned goal id, objective, and status
  as the durable source of truth.
- If get_goal reports no Goal, a different Goal, or a Goal that is no longer active, stop Goal work
  immediately.
- If the returned Goal is active, continue its full objective from current authoritative evidence.
- Call update_goal only when the objective is proven complete, the strict blocked threshold is
  satisfied, or a valid token-budget change is required. Otherwise keep making concrete progress and
  leave the Goal active.
