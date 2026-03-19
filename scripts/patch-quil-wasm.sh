#!/bin/bash
# Patches the @quilibrium/quilibrium-js-sdk-channels package.
# 1. Copies missing WASM binary
# 2. Fixes signWithPasskey JSON parse bug (largeBlob can be hex, not just JSON)

SDK_DIST="node_modules/@quilibrium/quilibrium-js-sdk-channels/dist"

# --- WASM patch ---
SRC="scripts/patches/channelwasm_bg.wasm"
DEST_SDK="$SDK_DIST/channelwasm_bg.wasm"
DEST_PUBLIC="public/channelwasm_bg.wasm"

if [ -f "$SRC" ]; then
  if [ ! -f "$DEST_SDK" ]; then
    cp "$SRC" "$DEST_SDK"
    echo "Patched: copied channelwasm_bg.wasm into SDK dist/"
  fi
  if [ ! -f "$DEST_PUBLIC" ]; then
    cp "$SRC" "$DEST_PUBLIC"
    echo "Patched: copied channelwasm_bg.wasm into public/"
  fi
fi

# --- signWithPasskey JSON parse fix ---
# The SDK assumes cred.largeBlob is always JSON ({private_key: [...]}) but on
# PRF-compatible browsers it can be a hex string. This patch adds a try/catch.
ESM_FILE="$SDK_DIST/index.esm.js"
if [ -f "$ESM_FILE" ]; then
  # Check if already patched
  if ! grep -q 'Try JSON format first' "$ESM_FILE"; then
    node -e "
      const fs = require('fs');
      let code = fs.readFileSync('$ESM_FILE', 'utf8');
      const old = \"return js_sign_ed448(Buffer.from(JSON.parse(cred.largeBlob).private_key).toString('base64'), payload);\";
      const fix = \"let keyBase64; try { /* Try JSON format first */ const parsed = JSON.parse(cred.largeBlob); keyBase64 = Buffer.from(new Uint8Array(parsed.private_key)).toString('base64'); } catch (e) { keyBase64 = cred.largeBlob; } return js_sign_ed448(keyBase64, payload);\";
      if (code.includes(old)) {
        code = code.replace(old, fix);
        fs.writeFileSync('$ESM_FILE', code);
        console.log('Patched: signWithPasskey JSON parse fix applied');
      } else {
        console.log('Patch: signWithPasskey target not found (may already be patched)');
      }
    "
  else
    echo "Patch: signWithPasskey already patched, skipping"
  fi
fi
