import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Resolve a repository-relative regular file while rejecting symlinks at every path segment. */
export function assertUpdateRepositoryFile(rootPath: string, relativePath: string, allowMissingLeaf = false): string {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.includes('://')) {
    throw new Error('Update paths must be repository-relative paths');
  }
  const segments = relativePath.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) throw new Error('Update paths cannot contain traversal or empty segments');
  const root = realpathSync(rootPath);
  const candidate = resolve(root, ...segments);
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Update path escapes repository root');

  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (allowMissingLeaf && index === segments.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return current;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Update path cannot traverse a symbolic link: ${relativePath}`);
    const leaf = index === segments.length - 1;
    if (!leaf && !stat.isDirectory()) throw new Error(`Update path parent is not a directory: ${relativePath}`);
    if (leaf && !stat.isFile()) throw new Error(`Update path is not a regular file: ${relativePath}`);
  }
  return current;
}

/** Require the complete validated saved document, not merely a manifest digest, to match. */
export function assertSavedUpdateCatalogParity<T>(
  rootPath: string,
  relativePath: string,
  expectedCanonical: string,
  canonicalize: (document: unknown) => string,
): void {
  const path = assertUpdateRepositoryFile(rootPath, relativePath);
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read valid saved update catalog: ${(error as Error).message}`);
  }
  if (canonicalize(document) !== expectedCanonical) throw new Error('Saved update catalog differs from pinned source assembly');
}
