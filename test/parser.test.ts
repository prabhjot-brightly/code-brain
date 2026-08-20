import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseFile } from '../src/parser.js';

test('indexes Java methods and AST-derived call candidates', () => {
  const repository = mkdtempSync(path.join(os.tmpdir(), 'rkg-java-'));
  const file = path.join(repository, 'OrderService.java');
  writeFileSync(file, [
    'package com.example.orders;',
    '',
    'class OrderService {',
    '  void sync() {',
    '    persist();',
    '  }',
    '',
    '  void persist() {}',
    '}',
  ].join('\n'));

  try {
    const result = parseFile(file, repository);
    const sync = result.nodes.find(node => node.name === 'sync');
    const persist = result.nodes.find(node => node.name === 'persist');
    const call = result.edges.find(edge => edge.type === 'CALLS');

    assert.ok(sync);
    assert.equal(sync.language, 'java');
    assert.equal(sync.qualifiedName, 'com.example.orders.OrderService.sync');
    assert.ok(sync.endLine > sync.startLine);
    assert.ok(persist);
    assert.equal(call?.source, sync.id);
    assert.equal(call?.target, persist.name);
    assert.equal(call?.resolution, 'ast');
    assert.equal(call?.confidence, 0.6);
    assert.equal(call?.sourceLine, 5);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});