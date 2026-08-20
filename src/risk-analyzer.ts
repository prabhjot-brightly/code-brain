import { createHash } from 'node:crypto';
import type { CodeNode, StaticFinding } from './types.js';

const OUTBOUND_CALL = /\b(fetch|axios\.|got\(|request\(|http\.request|https\.request|requests\.(get|post|put|delete)|aiohttp\.|grpc\.|redis\.)/i;
const TIMEOUT_GUARD = /\b(timeout|AbortSignal|wait_for|WithTimeout|deadline)\b/i;

function findingId(node: CodeNode, ruleId: string): string {
  return createHash('sha1').update(`${node.id}:${ruleId}`).digest('hex').slice(0, 16);
}

function finding(
  node: CodeNode,
  ruleId: string,
  severity: StaticFinding['severity'],
  message: string,
): StaticFinding {
  return {
    id: findingId(node, ruleId),
    ruleId,
    severity,
    message,
    nodeId: node.id,
    filePath: node.filePath,
    line: node.startLine,
  };
}

/** Deterministic, source-visible risk checks; findings are not runtime proof. */
export function analyzeRuntimeRisks(nodes: CodeNode[]): StaticFinding[] {
  const findings: StaticFinding[] = [];
  for (const node of nodes) {
    if (node.type !== 'METHOD' && node.type !== 'FUNCTION') continue;
    const source = node.sourceCode ?? '';
    if (!source) continue;

    if (OUTBOUND_CALL.test(source) && !TIMEOUT_GUARD.test(source)) {
      findings.push(finding(
        node,
        'outbound-call-without-visible-timeout',
        'medium',
        'Outbound call is visible but no timeout or deadline is visible in this function.',
      ));
    }
    if (/\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/.test(source)) {
      findings.push(finding(
        node,
        'unbounded-loop',
        'medium',
        'Unbounded loop is visible; verify cancellation, backoff, and termination conditions.',
      ));
    }
  }
  return findings;
}