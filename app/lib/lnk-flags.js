'use strict';

/**
 * Shell Link (.lnk) header flags, as pure Buffer operations ([MS-SHLLINK] 2.1).
 *
 * The work-hours branch marked the widget's shortcuts «Run as administrator» (SLDF_RUNAS_USER),
 * so the whole app ran elevated. The app now never runs elevated (only a short helper does, per
 * change), and shell.writeShortcutLink keeps that flag when it updates a link, so the flag is
 * cleared after every write.
 */

const HEADER_SIZE = 0x4c;
/** LinkCLSID 00021401-0000-0000-C000-000000000046 as stored (little-endian GUID). */
const LINK_CLSID = Buffer.from('0114020000000000c000000000000046', 'hex');
/** LinkFlags: a little-endian DWORD at offset 0x14. */
const LINK_FLAGS_OFFSET = 0x14;
/** SLDF_RUNAS_USER: bit 0x20 of the second byte (0x15). */
const SLDF_RUNAS_USER = 0x00002000;

/**
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isShellLink(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= HEADER_SIZE &&
    buf.readUInt32LE(0) === HEADER_SIZE &&
    buf.subarray(4, 20).equals(LINK_CLSID)
  );
}

/**
 * @param {Buffer} buf
 * @returns {boolean}
 */
function hasRunAsFlag(buf) {
  return isShellLink(buf) && (buf.readUInt32LE(LINK_FLAGS_OFFSET) & SLDF_RUNAS_USER) !== 0;
}

/**
 * Clear «Run as administrator». Never modifies `buf`; anything that is not a shell link is
 * returned as is.
 * @param {Buffer} buf
 * @returns {{ buffer: Buffer, changed: boolean }}
 */
function clearRunAsFlag(buf) {
  if (!hasRunAsFlag(buf)) return { buffer: buf, changed: false };
  const out = Buffer.from(buf);
  out.writeUInt32LE((out.readUInt32LE(LINK_FLAGS_OFFSET) & ~SLDF_RUNAS_USER) >>> 0, LINK_FLAGS_OFFSET);
  return { buffer: out, changed: true };
}

module.exports = { isShellLink, hasRunAsFlag, clearRunAsFlag, SLDF_RUNAS_USER, LINK_FLAGS_OFFSET };
