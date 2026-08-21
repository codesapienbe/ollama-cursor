/*  Tiny glob matcher for the exclude patterns shared with the IDE settings
 *  (`**​/{.git,node_modules,…}/**`). Supports `**`, `*`, `?`, `{a,b}` and
 *  character classes against POSIX-style relative paths.                  */

export interface GlobMatcher {
  matches(relativePath: string): boolean;
  /** True when nothing inside this directory can ever be included. */
  prunesDirectory(relativeDir: string): boolean;
}

function toRegExpSource(glob: string): string {
  let source = '';
  let index = 0;

  while (index < glob.length) {
    const char = glob[index];

    if (char === '*') {
      const isDoubleStar = glob[index + 1] === '*';
      if (isDoubleStar) {
        const followedBySlash = glob[index + 2] === '/';
        source += followedBySlash ? '(?:.*/)?' : '.*';
        index += followedBySlash ? 3 : 2;
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    if (char === '{') {
      const end = glob.indexOf('}', index);
      if (end !== -1) {
        const alternatives = glob.slice(index + 1, end).split(',');
        source += `(?:${alternatives.map(toRegExpSource).join('|')})`;
        index = end + 1;
        continue;
      }
    }

    if (char === '[') {
      const end = glob.indexOf(']', index);
      if (end !== -1) {
        const body = glob.slice(index + 1, end).replace(/\\/g, '\\\\');
        source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
        index = end + 1;
        continue;
      }
    }

    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    index += 1;
  }

  return source;
}

export function compileGlob(glob: string): GlobMatcher {
  const trimmed = glob.trim();
  if (!trimmed) {
    return { matches: () => false, prunesDirectory: () => false };
  }

  const regex = new RegExp(`^${toRegExpSource(trimmed)}$`);
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');

  return {
    matches: (relativePath: string) => regex.test(normalize(relativePath)),
    /* A directory is prunable when a hypothetical child inside it is
       excluded — that is how `**​/node_modules/**` rules out the whole tree. */
    prunesDirectory: (relativeDir: string) => {
      const normalized = normalize(relativeDir);
      return regex.test(`${normalized}/__olliberty_probe__`) || regex.test(normalized);
    }
  };
}
