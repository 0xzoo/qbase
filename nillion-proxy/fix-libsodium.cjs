// This script fixes broken ESM builds in Nillion dependencies

const fs = require('fs');
const path = require('path');

// Fix 1: libsodium-wrappers-sumo missing .mjs file
const libsodiumDir = path.join(__dirname, 'node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm');
const libsodiumFile = path.join(libsodiumDir, 'libsodium-sumo.mjs');

if (!fs.existsSync(libsodiumDir)) {
  fs.mkdirSync(libsodiumDir, { recursive: true });
}

if (!fs.existsSync(libsodiumFile)) {
  const shimContent = `
// Auto-generated shim to fix broken ESM build
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const libsodium = require('libsodium-sumo');
export default libsodium;
`;
  fs.writeFileSync(libsodiumFile, shimContent);
  console.log('Created libsodium-sumo.mjs shim');
}

// Fix 2: @nillion/secretvaults missing default export condition
const secretvaultsPkg = path.join(__dirname, 'node_modules/@nillion/secretvaults/package.json');
if (fs.existsSync(secretvaultsPkg)) {
  const pkg = JSON.parse(fs.readFileSync(secretvaultsPkg, 'utf8'));
  // Add default condition to exports
  if (pkg.exports && pkg.exports['.'] && !pkg.exports['.'].default) {
    pkg.exports['.'].default = './dist/lib.js';
    pkg.main = './dist/lib.js';
    fs.writeFileSync(secretvaultsPkg, JSON.stringify(pkg, null, 2));
    console.log('Fixed exports for @nillion/secretvaults');
  }
}

// Fix 3: @nillion/nuc missing default export condition  
const nucPkg = path.join(__dirname, 'node_modules/@nillion/nuc/package.json');
if (fs.existsSync(nucPkg)) {
  const pkg = JSON.parse(fs.readFileSync(nucPkg, 'utf8'));
  if (pkg.exports && pkg.exports['.'] && !pkg.exports['.'].default) {
    pkg.exports['.'].default = './dist/lib.mjs';  // Note: .mjs not .js
    pkg.main = './dist/lib.mjs';
    fs.writeFileSync(nucPkg, JSON.stringify(pkg, null, 2));
    console.log('Fixed exports for @nillion/nuc');
  }
}

console.log('All fixes applied');

