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

test('indexes C# namespaces, declarations, inheritance, imports and calls', () => {
  const repository = mkdtempSync(path.join(os.tmpdir(), 'rkg-csharp-'));
  const file = path.join(repository, 'OrderService.cs');
  writeFileSync(file, [
    'using Example.Contracts;',
    'namespace Example.Orders;',
    'public interface IOrderService : IDisposable { void Sync(); }',
    'public class OrderService : BaseService, IOrderService {',
    '  public void Sync() { Persist(); }',
    '  private void Persist() {}',
    '}',
    'public struct OrderId : IEquatable<OrderId> {}',
  ].join('\n'));

  try {
    const result = parseFile(file, repository);
    const service = result.nodes.find(node => node.name === 'OrderService');
    const sync = result.nodes.find(node => node.name === 'Sync' && node.type === 'METHOD' && node.startLine === 5);
    const persist = result.nodes.find(node => node.name === 'Persist');

    assert.equal(service?.qualifiedName, 'Example.Orders.OrderService');
    assert.equal(service?.language, 'csharp');
    assert.equal(sync?.qualifiedName, 'Example.Orders.OrderService.Sync');
    assert.ok(persist);
    assert.ok(result.edges.some(edge => edge.type === 'CONTAINS' && edge.source === service?.id && edge.target === sync?.id));
    assert.ok(result.edges.some(edge => edge.type === 'CALLS' && edge.source === sync?.id && edge.target === 'Persist' && edge.sourceLine === 5));
    assert.ok(result.extendsRefs.some(ref => ref.sourceId === service?.id && ref.targetName === 'BaseService'));
    assert.ok(result.implementsRefs.some(ref => ref.sourceId === service?.id && ref.targetName === 'IOrderService'));
    const contract = result.nodes.find(node => node.name === 'IOrderService');
    const orderId = result.nodes.find(node => node.name === 'OrderId');
    assert.ok(result.extendsRefs.some(ref => ref.sourceId === contract?.id && ref.targetName === 'IDisposable'));
    assert.ok(result.implementsRefs.some(ref => ref.sourceId === orderId?.id && ref.targetName === 'IEquatable'));
    assert.ok(result.importRefs.some(ref => ref.targetName === 'Example.Contracts'));
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('indexes C# block namespaces and excludes enum underlying types from inheritance', () => {
  const repository = mkdtempSync(path.join(os.tmpdir(), 'rkg-csharp-'));
  const file = path.join(repository, 'Worker.cs');
  writeFileSync(file, [
    'namespace Outer {',
    '  namespace Inner {',
    '    enum Status : byte { Active }',
    '    class Worker { void Work() { Console.WriteLine(1); } }',
    '  }',
    '}',
  ].join('\n'));

  try {
    const result = parseFile(file, repository);
    const worker = result.nodes.find(node => node.name === 'Worker');
    const work = result.nodes.find(node => node.name === 'Work');
    const status = result.nodes.find(node => node.name === 'Status');
    assert.equal(worker?.qualifiedName, 'Outer.Inner.Worker');
    assert.equal(work?.qualifiedName, 'Outer.Inner.Worker.Work');
    assert.ok(result.edges.some(edge => edge.source === work?.id && edge.target === 'WriteLine' && edge.type === 'CALLS'));
    assert.ok(status);
    assert.ok(!result.extendsRefs.some(ref => ref.sourceId === status.id));
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});