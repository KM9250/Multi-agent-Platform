import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthError } from "../auth/authorization.ts";

const checkoutRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const within = (path: string, base: string) =>
  path === base || path.startsWith(base + sep);
/** Host data can never overlap shipped source or the public static directory. */
export function protectedDataRoot(value: string, staticRoot?: string): string {
  if (!isAbsolute(value))
    throw new AuthError("ABSOLUTE_DATA_ROOT_REQUIRED", 400);
  const root = resolve(value);
  if (within(root, checkoutRoot))
    throw new AuthError("DATA_ROOT_OVERLAPS_SOURCE", 400);
  if (
    staticRoot &&
    (within(root, resolve(staticRoot)) || within(resolve(staticRoot), root))
  )
    throw new AuthError("DATA_ROOT_OVERLAPS_STATIC", 400);
  return root;
}
