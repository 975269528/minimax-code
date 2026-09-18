const LOGIN_RESTART_ENVIRONMENT_KEY = '__MAVIS_TUI_LOGIN_RESTART';

export function markLoginRestartHandoff(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...environment, [LOGIN_RESTART_ENVIRONMENT_KEY]: '1' };
}

export function consumeLoginRestartHandoff(environment: NodeJS.ProcessEnv): boolean {
  if (environment[LOGIN_RESTART_ENVIRONMENT_KEY] !== '1') return false;
  delete environment[LOGIN_RESTART_ENVIRONMENT_KEY];
  return true;
}
