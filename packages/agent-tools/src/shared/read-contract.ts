/**
 * Maximum number of Unicode code points the model-facing `read` wrapper keeps
 * from one physical line before appending its truncation marker.
 *
 * Kept in a side-effect-free module so artifact producers can build a
 * recoverable representation without loading the desktop tool registry.
 */
export const READ_MAX_LINE_CHARS = 2_000;
