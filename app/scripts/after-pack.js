'use strict';

/**
 * electron-builder afterPack hook: flip Electron fuses on the packaged executable.
 * The widget loads one local page from app.asar and never needs Node-as-interpreter,
 * so everything an attacker could use to run code through the signed-looking exe is off.
 *
 *  runAsNode                              off  ELECTRON_RUN_AS_NODE=1 turns the exe into `node`
 *  enableNodeOptionsEnvironmentVariable   off  NODE_OPTIONS can inject code
 *  enableNodeCliInspectArguments          off  --inspect / --inspect-brk open a debugger port
 *  enableEmbeddedAsarIntegrityValidation  on   refuse to start with a modified app.asar
 *  onlyLoadAppFromAsar                    on   never fall back to a loose app/ folder
 *  enableCookieEncryption                 on   Chromium cookies encrypted at rest
 *
 * grantFileProtocolExtraPrivileges stays at its default: the UI is loaded from file://.
 */

const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/** @param {import('electron-builder').AfterPackContext} context */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
  });
  console.log(`  • fuses flipped  ${path.basename(exe)}`);
};
