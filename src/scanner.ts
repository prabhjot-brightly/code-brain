import fs from 'node:fs';
import path from 'node:path';
import type { ScanOptions } from './types.js';

const DEFAULT_IGNORE = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage',
  '.next', '__pycache__', '.venv', 'venv', 'env',
  'vendor', 'target', '.gradle', '.idea', '.vscode',
  'bin', 'obj', 'out', 'tmp', '.cache',
  // test directories
  '__tests__', '__mocks__', 'test', 'tests', 'spec', 'specs', 'e2e', 'cypress',
]);

/** File name suffixes that identify test / mock files — skipped regardless of directory. */
const TEST_SUFFIXES = [
  '.test.ts', '.test.tsx', '.test.js', '.test.jsx',
  '.spec.ts', '.spec.tsx', '.spec.js', '.spec.jsx',
  '.test.mjs', '.spec.mjs',
  '-test.ts', '-test.js',
];

// Every mainstream language — works for any repo out of the box
const DEFAULT_EXTENSIONS = new Set([
  // TypeScript / JavaScript
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  // Python
  '.py', '.pyw',
  // Java / Kotlin / Scala
  '.java', '.kt', '.kts', '.scala',
  // C / C++
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
  // C#
  '.cs',
  // Go
  '.go',
  // Rust
  '.rs',
  // Ruby
  '.rb',
  // PHP
  '.php',
  // Swift
  '.swift',
  // Shell
  '.sh', '.bash',
  // Dart
  '.dart',
  // Elixir / Erlang
  '.ex', '.exs', '.erl',
  // Lua
  '.lua',
  // R
  '.r', '.R',
  // Configuration and deployment descriptors
  '.json', '.yaml', '.yml', '.toml', '.ini', '.properties', '.xml',
]);

const DEFAULT_FILENAMES = new Set([
  'dockerfile', 'compose.yml', 'compose.yaml', 'codeowners',
]);

export function scanRepository(root: string, opts?: ScanOptions): string[] {
  const extensions = opts?.extensions
    ? new Set(opts.extensions)
    : DEFAULT_EXTENSIONS;

  const ignore = new Set([
    ...DEFAULT_IGNORE,
    ...(opts?.ignore ?? []),
  ]);

  const result: string[] = [];

  function walk(directory: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // skip unreadable dirs
    }

    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;

      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      const lowerName = entry.name.toLowerCase();
      if (TEST_SUFFIXES.some(s => lowerName.endsWith(s))) continue;

      if (
        extensions.has(path.extname(entry.name).toLowerCase()) ||
        DEFAULT_FILENAMES.has(lowerName)
      ) {
        result.push(fullPath);
      }
    }
  }

  walk(root);
  return result;
}
