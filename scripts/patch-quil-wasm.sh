#!/bin/bash
# Patches the @quilibrium/quilibrium-js-sdk-channels package to include the missing WASM binary.
# The npm package ships without channelwasm_bg.wasm - this copies it from our local copy.
SRC="scripts/patches/channelwasm_bg.wasm"
DEST_SDK="node_modules/@quilibrium/quilibrium-js-sdk-channels/dist/channelwasm_bg.wasm"
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
