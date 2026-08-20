/**
 * stack-trace-parser.ts
 * ─────────────────────
 * Parses stack traces from Java, Node.js, Python, Go, and Kotlin into
 * structured frames that can be looked up in the knowledge graph.
 *
 * Supported formats:
 *   Java / Kotlin  →  at com.example.Foo.method(Foo.java:42)
 *   Node.js        →  at Foo.method (src/foo.ts:42:10)
 *   Python         →  File "src/foo.py", line 42, in method
 *   Go             →  goroutine … src/foo.go:42 +0x…
 */

export interface StackFrame {
  /** Short class or module name, e.g. "SyncEventService" */
  className?:  string;
  /** Method or function name, e.g. "publishSyncEvent" */
  methodName?: string;
  /**
   * Partial file path as it appears in the trace.
   * May be just a basename like "Foo.java" or a longer path fragment.
   */
  filePath?:   string;
  /** 1-based line number */
  line?:       number;
  /** Which format was used to parse this frame */
  lang:        'java' | 'node' | 'python' | 'go' | 'unknown';
}

export interface ParsedTrace {
  /** All frames extracted, outermost (nearest to the error) first */
  frames:        StackFrame[];
  /** The raw error/exception line that preceded the frames, if found */
  errorMessage?: string;
  /** Best single frame to look up — usually the first app-code frame */
  epicentre?:    StackFrame;
}

// ── Patterns ──────────────────────────────────────────────────────────────────

/** Java / Kotlin: `at com.example.pkg.ClassName.method(File.java:42)` */
const JAVA_FRAME =
  /^\s*at\s+([\w$.]+)\.([\w$<>]+)\((\w+\.(?:java|kt|groovy)):(\d+)\)/;

/** Node.js / TypeScript: `at method (path/to/file.ts:42:10)` or `at path/to/file.ts:42:10` */
const NODE_FRAME =
  /^\s*at\s+(?:([\w.<>$\s]+?)\s+\()?([^\s()]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(\d+):\d+\)?/;

/** Python: `  File "path/to/file.py", line 42, in method_name` */
const PYTHON_FRAME =
  /^\s*File\s+"([^"]+\.py)",\s+line\s+(\d+),\s+in\s+(\S+)/;

/** Go: `main.funcName(...)` followed by a tab + `path/file.go:42` */
const GO_FUNC  = /^(?:\S+\.)?(\w+)\(/;
const GO_FILE  = /^\s+(.+\.go):(\d+)/;

/** Typical error lines: ExceptionClassName: message OR Error: message */
const ERROR_LINE = /^(?:[\w$.]+(?:Exception|Error|Panic|Fault|Throwable)\b.*|(?:Exception|Error|Fatal|panic):.*)/i;

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseJavaFrame(line: string): StackFrame | null {
  const m = JAVA_FRAME.exec(line);
  if (!m) return null;
  const fqn       = m[1]!;                         // com.example.pkg.ClassName
  const className = fqn.split('.').at(-1) ?? fqn;  // ClassName
  return {
    className,
    methodName: m[2]!,
    filePath:   m[3]!,
    line:       Number(m[4]),
    lang:       'java',
  };
}

function parseNodeFrame(line: string): StackFrame | null {
  const m = NODE_FRAME.exec(line);
  if (!m) return null;
  // m[1] = "ClassName.method" or undefined (anonymous)
  const qualName  = m[1]?.trim();
  const parts     = qualName?.split('.') ?? [];
  const className = parts.length > 1 ? parts[parts.length - 2] : undefined;
  const method    = parts.at(-1);
  return {
    className:  className,
    methodName: method === '<anonymous>' || !method ? undefined : method,
    filePath:   m[2]!,
    line:       Number(m[3]),
    lang:       'node',
  };
}

function parsePythonFrame(line: string): StackFrame | null {
  const m = PYTHON_FRAME.exec(line);
  if (!m) return null;
  return {
    methodName: m[3] === '<module>' ? undefined : m[3],
    filePath:   m[1]!,
    line:       Number(m[2]),
    lang:       'python',
  };
}

/**
 * Go stack traces interleave a function line with a file line.
 * Returns a partial frame from a func line, or file info from a file line.
 */
function parseGoLine(line: string, prevFrame: StackFrame | null): StackFrame | null {
  const fileMatch = GO_FILE.exec(line);
  if (fileMatch && prevFrame?.lang === 'go') {
    // Complete the partial frame from the previous func line
    return { ...prevFrame, filePath: fileMatch[1]!, line: Number(fileMatch[2]) };
  }
  const funcMatch = GO_FUNC.exec(line.trimStart());
  if (funcMatch && !line.trimStart().startsWith('at ')) {
    return { methodName: funcMatch[1], lang: 'go' };
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a raw stack trace string (or just a question mentioning an error) into
 * structured frames, and identify the best epicentre frame for Neo4j lookup.
 *
 * Noise frames from JDK internals, Node.js internals, and test runners are
 * filtered out so the epicentre points to application code.
 */
export function parseStackTrace(input: string): ParsedTrace {
  const lines  = input.split(/\r?\n/);
  const frames: StackFrame[] = [];
  let errorMessage: string | undefined;
  let goPending: StackFrame | null = null;

  for (const line of lines) {
    // Capture the error/exception header
    if (!errorMessage && ERROR_LINE.test(line.trim())) {
      errorMessage = line.trim();
      continue;
    }

    // Try each format in order
    const javaFrame = parseJavaFrame(line);
    if (javaFrame) { frames.push(javaFrame); goPending = null; continue; }

    const nodeFrame = parseNodeFrame(line);
    if (nodeFrame) { frames.push(nodeFrame); goPending = null; continue; }

    const pythonFrame = parsePythonFrame(line);
    if (pythonFrame) { frames.push(pythonFrame); goPending = null; continue; }

    // Go: two-line frames
    const goResult = parseGoLine(line, goPending);
    if (goResult) {
      if (goResult.filePath) {
        frames.push(goResult);
        goPending = null;
      } else {
        goPending = goResult;  // wait for the file line
      }
    }
  }

  return {
    frames,
    errorMessage,
    epicentre: findEpicentre(frames),
  };
}

/**
 * Pick the best frame to look up in the knowledge graph:
 * - Prefer frames that have both a file path and a line number
 * - Skip JDK/Node internals (sun.*, java.*, node:*)
 * - Take the outermost (first) qualifying frame — closest to where things broke
 */
function findEpicentre(frames: StackFrame[]): StackFrame | undefined {
  const isInternal = (f: StackFrame): boolean => {
    const p = f.filePath ?? '';
    const c = f.className ?? '';
    if (/^(sun|java|javax|jdk|com\.sun)\b/.test(c)) return true;
    if (/^node:/.test(p)) return true;
    if (p.includes('node_modules')) return true;
    // Java test runner noise
    if (/^(org\.junit|org\.mockito|org\.springframework\.test)\b/.test(c)) return true;
    return false;
  };

  return frames.find(f => f.line !== undefined && f.filePath && !isInternal(f));
}

/**
 * Extract any plain file:line hints that appear in a question string,
 * even when there's no full stack trace.
 * e.g. "SyncService.java line 42" or "at line 42 in SyncEventService"
 */
export function extractLineHints(text: string): Array<{ fileHint: string; line: number }> {
  const results: Array<{ fileHint: string; line: number }> = [];
  // "FileName.java:42" or "FileName.ts:42"
  const fileColon = /(\w+\.(?:java|kt|ts|tsx|js|go|py|cs|rb|rs))\s*[:#]\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = fileColon.exec(text)) !== null) {
    results.push({ fileHint: m[1]!, line: Number(m[2]) });
  }
  // "line 42 in SomeClass" or "SomeClass line 42"
  const lineIn = /\bline\s+(\d+)\s+in\s+(\w+)/g;
  while ((m = lineIn.exec(text)) !== null) {
    results.push({ fileHint: m[2]!, line: Number(m[1]) });
  }
  const inLine = /\b(\w+)\s+(?:at\s+)?line\s+(\d+)\b/g;
  while ((m = inLine.exec(text)) !== null) {
    results.push({ fileHint: m[1]!, line: Number(m[2]) });
  }
  return results;
}
