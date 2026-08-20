import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { simpleGit } from 'simple-git';

export interface RepoMeta {
  repoPath: string;
  repoUrl: string;
  repoName: string;
  indexedAt: number;
}

/** Accept any of:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   github.com/owner/repo
 *   owner/repo
 */
export function parseGithubUrl(input: string): { url: string; name: string } {
  let cleaned = input.trim();

  // shorthand  owner/repo  (no slashes before the first one)
  if (/^[\w.-]+\/[\w.-]+$/.test(cleaned)) {
    cleaned = `https://github.com/${cleaned}`;
  } else if (!cleaned.startsWith('http')) {
    cleaned = `https://${cleaned}`;
  }

  // ensure .git suffix
  if (!cleaned.endsWith('.git')) cleaned += '.git';

  const name = cleaned.split('/').at(-1)?.replace(/\.git$/, '') ?? 'repo';
  return { url: cleaned, name };
}

export async function cloneOrPull(
  input: string,
  reposDir: string,
): Promise<RepoMeta> {
  const { url, name } = parseGithubUrl(input);
  const repoPath = path.join(reposDir, name);

  if (fs.existsSync(path.join(repoPath, '.git'))) {
    process.stdout.write(`Repo already cloned — pulling latest changes …\n`);
    await simpleGit(repoPath).pull();
  } else {
    fs.mkdirSync(repoPath, { recursive: true });
    process.stdout.write(`Cloning ${url} → ${repoPath} …\n`);
    await simpleGit().clone(url, repoPath, ['--depth', '1']);
  }

  return { repoPath, repoUrl: url, repoName: name, indexedAt: Date.now() };
}

// ─── Persist last-indexed repo so `query` can find it ────────────────────────

export function saveMeta(dataDir: string, meta: RepoMeta): void {
  fs.writeFileSync(
    path.join(dataDir, 'meta.json'),
    JSON.stringify(meta, null, 2),
  );
}

export function loadMeta(dataDir: string): RepoMeta | null {
  const metaPath = path.join(dataDir, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as RepoMeta;
  } catch {
    return null;
  }
}
