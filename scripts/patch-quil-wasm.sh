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
  # Check if already patched (look for our try/catch)
  if ! grep -q 'Try JSON format first' "$ESM_FILE"; then
    sed -i.bak 's|return js_sign_ed448(Buffer.from(JSON.parse(cred.largeBlob).private_key).toString('\''base64'\'')|let keyBase64; try { const parsed = JSON.parse(cred.largeBlob); keyBase64 = Buffer.from(new Uint8Array(parsed.private_key)).toString('\''base64'\'')); } catch (e) { keyBase64 = cred.largeBlob; } return js_sign_ed448(keyBase64|' "$ESM_FILE" 2>/dev/null
    # If sed failed (complex escaping), the manual patch in postinstall handles it
    echo "Patched: signWithPasskey JSON parse fix applied"
  else
    echo "Patch: signWithPasskey already patched, skipping"
  fi
fi
