'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { loadDoc, saveDoc, deleteDoc } = require('../lib/storage-files');
const { getStorageEvents } = require('../lib/storage-status');
const { useTempDataRoot, read, readJsonFile, write, exists } = require('./helpers/tmp-data');

let env;
test.beforeEach(() => {
  env = useTempDataRoot();
});
test.afterEach(() => env.cleanup());

/** Example document: v0 = { items: [..] }, v1 = { items: [{ name }] }, v2 adds `count`. */
function spec(extra = {}) {
  return {
    name: 'doc.json',
    file: () => path.join(env.dir, 'doc.json'),
    version: 2,
    keepBak: true,
    migrations: {
      1: (d) => ({ items: (d.items || []).map((name) => ({ name })) }),
      2: (d) => ({ ...d, count: d.items.length }),
    },
    ...extra,
  };
}

const kinds = () => getStorageEvents().map((e) => e.kind);

test('missing file: no data, nothing created, no events', () => {
  assert.deepEqual(loadDoc(spec()), { data: null, status: 'missing' });
  assert.deepEqual(fs.readdirSync(env.dir), []);
  assert.deepEqual(kinds(), []);
});

test('a file without schemaVersion is version 0: migrated stepwise, backed up, rewritten', () => {
  write(env.dir, 'doc.json', { items: ['a', 'b'] });
  const res = loadDoc(spec());
  assert.equal(res.status, 'migrated');
  assert.equal(res.migratedFrom, 0);
  assert.deepEqual(res.data, { schemaVersion: 2, items: [{ name: 'a' }, { name: 'b' }], count: 2 });

  // the file on disk is already the new format ...
  assert.deepEqual(readJsonFile(env.dir, 'doc.json'), res.data);
  // ... and the original survives untouched in backups/migrations
  const dir = path.join(env.dir, 'backups', 'migrations');
  const copies = fs.readdirSync(dir);
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^doc\.json\.v0\.\d+\.bak$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, copies[0]), 'utf8')), { items: ['a', 'b'] });
  assert.deepEqual(kinds(), ['migrated']);

  // second load: nothing to do
  assert.equal(loadDoc(spec()).status, 'ok');
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('migrations only run for the missing versions', () => {
  write(env.dir, 'doc.json', { schemaVersion: 1, items: [{ name: 'x' }] });
  const res = loadDoc(spec());
  assert.equal(res.migratedFrom, 1);
  assert.deepEqual(res.data, { schemaVersion: 2, items: [{ name: 'x' }], count: 1 });
});

test('a current-version file is returned as is, with no backup and no write', () => {
  const doc = { schemaVersion: 2, items: [], count: 0 };
  write(env.dir, 'doc.json', doc);
  const before = fs.statSync(path.join(env.dir, 'doc.json')).mtimeMs;
  assert.deepEqual(loadDoc(spec()), { data: doc, status: 'ok' });
  assert.equal(fs.statSync(path.join(env.dir, 'doc.json')).mtimeMs, before);
  assert.equal(exists(env.dir, 'backups'), false);
});

test('a failing migration keeps the original (backup + quarantine) and does not crash', () => {
  write(env.dir, 'doc.json', { items: ['a'] });
  const res = loadDoc(
    spec({
      migrations: {
        1: () => {
          throw new Error('boom');
        },
      },
    })
  );
  assert.deepEqual(res, { data: null, status: 'reset' });
  const names = fs.readdirSync(env.dir);
  assert.ok(names.some((n) => /^doc\.json\.corrupt-\d+$/.test(n)), 'original moved aside');
  assert.equal(fs.readdirSync(path.join(env.dir, 'backups', 'migrations')).length, 1);
  assert.deepEqual(kinds(), ['migration-failed']);
});

test('a file from a NEWER app is copied once and never downgraded', () => {
  write(env.dir, 'doc.json', { schemaVersion: 9, items: ['future'] });
  const first = loadDoc(spec());
  assert.equal(first.status, 'newer');
  assert.deepEqual(first.data.items, ['future']);
  loadDoc(spec());
  const copies = fs.readdirSync(path.join(env.dir, 'backups', 'migrations'));
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^doc\.json\.newer-v9\.\d+\.bak$/);
  assert.deepEqual(kinds(), ['newer-schema']);
  // the file itself is untouched
  assert.equal(readJsonFile(env.dir, 'doc.json').schemaVersion, 9);
});

test('saveDoc stamps the current schemaVersion first and writes an identical .bak', () => {
  saveDoc(spec(), { items: [], count: 0, schemaVersion: 1 });
  const main = read(env.dir, 'doc.json');
  assert.equal(Object.keys(JSON.parse(main))[0], 'schemaVersion');
  assert.equal(JSON.parse(main).schemaVersion, 2);
  assert.equal(read(env.dir, 'doc.json.bak'), main);
});

test('saveDoc without keepBak writes no .bak', () => {
  saveDoc(spec({ keepBak: false }), { items: [] });
  assert.equal(exists(env.dir, 'doc.json.bak'), false);
});

test('corrupt file is quarantined and restored from the last good copy', () => {
  saveDoc(spec(), { items: [{ name: 'keep' }], count: 1 });
  fs.writeFileSync(path.join(env.dir, 'doc.json'), '{"schemaVersion": 2, "items": [{"na');
  const res = loadDoc(spec());
  assert.equal(res.status, 'restored');
  assert.deepEqual(res.data.items, [{ name: 'keep' }]);
  // main file is valid again, the damaged one is kept for inspection
  assert.deepEqual(readJsonFile(env.dir, 'doc.json').items, [{ name: 'keep' }]);
  assert.ok(fs.readdirSync(env.dir).some((n) => /^doc\.json\.corrupt-\d+$/.test(n)));
  assert.deepEqual(kinds(), ['corrupt-quarantined', 'restored-from-backup']);
});

test('a parseable file of the wrong shape counts as corrupt too', () => {
  saveDoc(spec(), { items: [], count: 0 });
  fs.writeFileSync(path.join(env.dir, 'doc.json'), '[1,2,3]');
  const res = loadDoc(spec());
  assert.deepEqual(res.data.items, []);
  assert.deepEqual(kinds(), ['corrupt-quarantined', 'restored-from-backup']);
});

test('corrupt file with no usable .bak: data reset, damaged file kept, error event', () => {
  write(env.dir, 'doc.json', '{oops');
  write(env.dir, 'doc.json.bak', '{also oops');
  assert.deepEqual(loadDoc(spec()), { data: null, status: 'reset' });
  assert.ok(fs.readdirSync(env.dir).some((n) => /^doc\.json\.corrupt-\d+$/.test(n)));
  assert.deepEqual(kinds(), ['corrupt-quarantined', 'corrupt-reset']);
  assert.equal(getStorageEvents()[1].level, 'error');
});

test('a corrupt file without keepBak is not restored from a stray .bak', () => {
  write(env.dir, 'doc.json', '{oops');
  write(env.dir, 'doc.json.bak', { schemaVersion: 2, items: [], count: 0 });
  assert.equal(loadDoc(spec({ keepBak: false })).status, 'reset');
});

test('a deleted main file is NOT resurrected from .bak (deleting a file resets it)', () => {
  saveDoc(spec(), { items: [], count: 0 });
  fs.unlinkSync(path.join(env.dir, 'doc.json'));
  assert.equal(loadDoc(spec()).status, 'missing');
});

test('only the newest corrupt copies are kept', () => {
  for (let ts = 1; ts <= 5; ts += 1) write(env.dir, `doc.json.corrupt-${ts}`, 'old');
  write(env.dir, 'doc.json', '{oops');
  loadDoc(spec());
  const copies = fs.readdirSync(env.dir).filter((n) => n.includes('.corrupt-'));
  assert.equal(copies.length, 3);
  // the fresh one (timestamp = now) and the two newest old ones survive
  assert.ok(copies.includes('doc.json.corrupt-5'));
  assert.ok(copies.includes('doc.json.corrupt-4'));
  assert.ok(!copies.includes('doc.json.corrupt-1'));
});

test('pre-migration copies are pruned to a few per file', () => {
  for (let i = 0; i < 6; i += 1) {
    write(env.dir, 'doc.json', { items: [String(i)] });
    loadDoc(spec());
  }
  const copies = fs.readdirSync(path.join(env.dir, 'backups', 'migrations'));
  assert.ok(copies.length <= 3, `kept ${copies.length}`);
});

test('a failed write is reported and rethrown instead of being swallowed', () => {
  // parent "directory" is a regular file, so mkdir/write must fail
  write(env.dir, 'blocker', 'x');
  const bad = spec({ file: () => path.join(env.dir, 'blocker', 'doc.json') });
  assert.throws(() => saveDoc(bad, { items: [] }));
  assert.deepEqual(kinds(), ['write-failed']);
  assert.equal(getStorageEvents()[0].level, 'error');
});

test('deleteDoc removes the file and its .bak', () => {
  saveDoc(spec(), { items: [] });
  deleteDoc(spec());
  assert.deepEqual(fs.readdirSync(env.dir), []);
});
