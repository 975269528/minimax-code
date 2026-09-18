# MiniMax Code workflows reference

Use this reference for Coding/Work modes, workspace, tasks/history, conversation collaboration, code review, permissions, Browser, Files/Changes/Terminal panels, shortcuts, Goal, schedules, Remote Control, and IM.

## Stable model

Treat a workflow as the combination of product surface, workspace/project context, Agent capabilities, permissions, account/provider state, and task/session state. Desktop, Web, and `mcode` can expose different controls; absence in one surface is not proof that the capability does not exist.

## Official source discovery

Use only the current region's MiniMax Code index:

- `region: cn` → `https://agent.minimaxi.com/docs/llms.txt`
- `region: en` → `https://agent.minimax.io/docs/llms.txt`

Open the matching `.md` page. Relevant page families include `/docs/code/workflows/modes`, `/workspace`, `/tasks`, `/conversation-collaboration`, `/code-review`, `/permissions`, `/docs/code/desktop/browser`, `/panels`, `/shortcuts`, `/updates-feedback`, `/goal`, and `/docs/code/automation/schedules`, `/remote-control`, `/im`.

Do not hard-code labels, button locations, shortcuts, limits, or availability. Never query both regional indexes for an ordinary current-region question.

## Diagnostic workflow

1. Identify Desktop, Web/H5, or `mcode`, plus OS and version.
2. Establish whether the user means a project/workspace, task/session, or automation.
3. Check login, selected Agent/model/provider, permissions, and account entitlement.
4. Compare the current-region official surface documentation with the observed UI.
5. Give the shortest concrete next action and separate documented behavior from account- or rollout-dependent state.

## Boundaries

Explain observable user behavior only. Do not bypass permission prompts, claim a schedule or remote action was created without runtime evidence, or expose internal routing, credentials, or service endpoints.
