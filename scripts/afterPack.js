'use strict';

// electron-builder afterPack hook: ad-hoc code-sign the packaged macOS app.
//
// Without a Developer ID, electron-builder skips signing entirely. Repackaging
// Electron's prebuilt bundle (adding app.asar, rewriting Info.plist) breaks its
// original ad-hoc seal, and Gatekeeper then reports a quarantined download as
// "damaged" with no way to open it. Re-signing ad-hoc (`codesign -s -`) gives
// the bundle a consistent signature so users get the standard "unidentified
// developer" prompt instead, which can be bypassed via
// System Settings > Privacy & Security > Open Anyway.
//
// Skipped when a real signing identity is configured so we never clobber a
// proper Developer ID signature.

const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log('afterPack: signing identity configured, skipping ad-hoc signing');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`afterPack: ad-hoc signing ${appPath}`);
  // --deep re-signs nested frameworks/helpers inside-out so the outer seal is
  // valid; --force replaces the now-invalid signature from the prebuilt.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });
  console.log('afterPack: ad-hoc signature verified');
};
