import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !specifier.match(/\.[cm]?[jt]sx?$/)) {
    const parentPath = fileURLToPath(context.parentURL);
    const candidate = new URL(specifier + '.ts', pathToFileURL(parentPath));
    if (existsSync(fileURLToPath(candidate))) {
      return nextResolve(candidate.href, context);
    }
  }
  return nextResolve(specifier, context);
}
