export const TUI_BUNDLE_CHUNKS_DIRECTORY = "chunks";
const TUI_BUNDLE_STABLE_MODULE_URL_IDENTIFIER = "__mavis_tuiPackageEntryUrl";

export function createTuiBundleModuleLocationConfig() {
  const banner =
    'import { createRequire as __mavis_cR } from "module"; ' +
    'import { basename as __mavis_basename, dirname as __mavis_dirname, join as __mavis_join } from "path"; ' +
    'import { fileURLToPath as __mavis_fileURLToPath, pathToFileURL as __mavis_pathToFileURL } from "url"; ' +
    "const __mavis_tuiCurrentModuleDir = __mavis_dirname(__mavis_fileURLToPath(import.meta.url)); " +
    `const __mavis_tuiPackageRoot = __mavis_basename(__mavis_tuiCurrentModuleDir) === ${JSON.stringify(TUI_BUNDLE_CHUNKS_DIRECTORY)} ? __mavis_dirname(__mavis_tuiCurrentModuleDir) : __mavis_tuiCurrentModuleDir; ` +
    `const ${TUI_BUNDLE_STABLE_MODULE_URL_IDENTIFIER} = __mavis_pathToFileURL(__mavis_join(__mavis_tuiPackageRoot, "cli.js")).href; ` +
    `const require = __mavis_cR(${TUI_BUNDLE_STABLE_MODULE_URL_IDENTIFIER}); ` +
    "const __dirname = __mavis_tuiPackageRoot;";
  return {
    banner,
    define: Object.freeze({
      "import.meta.url": TUI_BUNDLE_STABLE_MODULE_URL_IDENTIFIER,
    }),
  };
}
