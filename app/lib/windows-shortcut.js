'use strict';

const fs = require('fs');

/**
 * Mark a Windows .lnk to "Run as administrator".
 * Electron shell.writeShortcutLink cannot set this; the Shell Link header
 * stores SLDF_RUNAS_USER in LinkFlags bit 0x20 at byte offset 0x15.
 *
 * @param {string} lnkPath
 */
function setLnkRunAsAdmin(lnkPath) {
  if (process.platform !== 'win32') return;
  const buf = Buffer.from(fs.readFileSync(lnkPath));
  if (buf.length < 0x16) {
    throw new Error(`shortcut too short: ${lnkPath}`);
  }
  // LinkFlags is a 4-byte little-endian DWORD starting at offset 0x14;
  // bit 0x20 (SLDF_RUNAS_USER) lives in the second byte (0x15).
  buf[0x15] = buf[0x15] | 0x20;
  fs.writeFileSync(lnkPath, buf);
}

module.exports = {
  setLnkRunAsAdmin,
};
