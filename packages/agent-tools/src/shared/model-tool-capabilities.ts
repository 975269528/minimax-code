/** Hide redundant external understanding tools when the model has native media understanding. */
export const MatrixWebSearchToolDef = { name: "web_search" } as const;
export function getSuppressedToolNamesForModelCapabilities(
  capabilities:
    | { support_image?: boolean; support_video?: boolean }
    | undefined,
): Set<string> {
  const names = new Set<string>();
  if (capabilities?.support_image === true) names.add("images_understand");
  if (capabilities?.support_video === true) names.add("videos_understand");
  return names;
}
