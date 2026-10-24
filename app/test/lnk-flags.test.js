'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isShellLink, hasRunAsFlag, clearRunAsFlag, SLDF_RUNAS_USER } = require('../lib/lnk-flags');

/** Minimal Shell Link header ([MS-SHLLINK] 2.1) with the given LinkFlags, plus a tail. */
function fakeLnk(linkFlags) {
  const buf = Buffer.alloc(0x4c + 8, 0xab);
  buf.writeUInt32LE(0x4c, 0);
  Buffer.from('0114020000000000c000000000000046', 'hex').copy(buf, 4);
  buf.writeUInt32LE(linkFlags, 0x14);
  return buf;
}

// HasLinkTargetIDList | HasName | HasWorkingDir | HasIconLocation | IsUnicode, as Explorer writes.
const TYPICAL = 0x00000001 | 0x00000004 | 0x00000010 | 0x00000040 | 0x00000080;

test('clears SLDF_RUNAS_USER (byte 0x15, bit 0x20) and nothing else', () => {
  const marked = fakeLnk(TYPICAL | SLDF_RUNAS_USER);
  assert.equal(marked[0x15] & 0x20, 0x20, 'the flag lives in byte 0x15');
  assert.ok(hasRunAsFlag(marked));
  const before = Buffer.from(marked);

  const { buffer, changed } = clearRunAsFlag(marked);
  assert.equal(changed, true);
  assert.equal(buffer[0x15] & 0x20, 0);
  assert.equal(buffer.readUInt32LE(0x14), TYPICAL, 'other LinkFlags kept');
  const diff = [...buffer].map((b, i) => (b !== before[i] ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(diff, [0x15], 'only one byte differs');
  assert.deepEqual(marked, before, 'input buffer not modified');
  assert.equal(hasRunAsFlag(buffer), false);
});

test('a link without the flag is returned as is', () => {
  const plain = fakeLnk(TYPICAL);
  const r = clearRunAsFlag(plain);
  assert.equal(r.changed, false);
  assert.equal(r.buffer, plain);
});

test('anything that is not a shell link is left alone', () => {
  const notLnk = Buffer.alloc(0x60, 0xff);
  assert.equal(isShellLink(notLnk), false);
  assert.deepEqual(clearRunAsFlag(notLnk), { buffer: notLnk, changed: false });
  const short = fakeLnk(SLDF_RUNAS_USER).subarray(0, 0x20);
  assert.equal(clearRunAsFlag(short).changed, false);
  const wrongClsid = fakeLnk(SLDF_RUNAS_USER);
  wrongClsid[4] = 0x02;
  assert.equal(clearRunAsFlag(wrongClsid).changed, false);
  assert.equal(clearRunAsFlag('not a buffer').changed, false);
});
