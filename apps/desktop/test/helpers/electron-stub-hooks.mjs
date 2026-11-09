/**
 * Minimal `electron` module stub for IPC-layer tests that import a module
 * which references `app` only for version/name derivation. Resolves the bare
 * specifier to an inline ESM module; everything else falls through.
 */
export async function resolve(specifier, context, next) {
  if (specifier === "electron") {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        'export const app = { getAppPath: () => process.cwd(), getVersion: () => "0.0.0-test", getName: () => "test", isPackaged: false };',
      ),
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
