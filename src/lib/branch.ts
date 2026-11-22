import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const BRANCH_PREFIX = 'ref: refs/heads/';

function readText(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function resolveGitDirectory(cwd: string): string | undefined {
  let directory = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(directory, '.git');
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) return dotGit;
      if (stat.isFile()) {
        const content = readText(dotGit) ?? '';
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match?.[1]) return path.resolve(directory, match[1].trim());
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function readCurrentBranch(cwd: string): string | undefined {
  const gitDirectory = resolveGitDirectory(cwd);
  if (!gitDirectory) return undefined;

  const head = (readText(path.join(gitDirectory, 'HEAD')) ?? '').trim();
  if (!head) return undefined;
  if (head.startsWith(BRANCH_PREFIX)) {
    const branch = head.slice(BRANCH_PREFIX.length).trim();
    return branch || undefined;
  }
  return head.startsWith('ref: ')
    ? head.slice('ref: '.length).trim() || undefined
    : head;
}
