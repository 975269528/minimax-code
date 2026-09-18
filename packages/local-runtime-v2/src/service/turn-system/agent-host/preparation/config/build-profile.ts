declare const __BUILD_PROFILE__: string | undefined;

/** Build-time product profile used by conversation prompt preparation. */
export function getLocalConversationBuildProfile(): string {
  return typeof __BUILD_PROFILE__ === 'string' ? __BUILD_PROFILE__ : 'default';
}

export function isLocalVelaBuild(buildProfile = getLocalConversationBuildProfile()): boolean {
  return buildProfile === 'vela';
}
