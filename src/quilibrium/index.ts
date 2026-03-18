// Quilibrium SDK wrapper for qbase
// Handles WASM initialization + re-exports passkey components

import { 
  PasskeysProvider, 
  usePasskeysContext, 
  PasskeyModal,
  channel_raw,
} from '@quilibrium/quilibrium-js-sdk-channels';

export { 
  PasskeysProvider, 
  usePasskeysContext, 
  PasskeyModal 
};

// FQ app prefix for qbase
export const FQ_APP_PREFIX = 'app.qbase';

// Initialize the WASM module - must complete before any crypto functions work.
// The SDK doesn't auto-init, so we do it here. Returns a promise that resolves
// once the WASM is ready.
let wasmReady: Promise<void> | null = null;

export function initQuilibriumWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (channel_raw as any).default().then(() => {
      console.log('[Quilibrium] WASM initialized');
    }).catch((err: Error) => {
      console.error('[Quilibrium] WASM init failed:', err);
      wasmReady = null; // Allow retry
      throw err;
    });
  }
  return wasmReady;
}

// Auto-init on import
initQuilibriumWasm();

// Helper to derive user address from public key (matches Quilibrium protocol)
export const deriveAddress = async (publicKey: number[]): Promise<string> => {
  const { sha256 } = await import('@noble/hashes/sha256');
  const { base58btc } = await import('multiformats/bases/base58');
  
  const hash = sha256(new Uint8Array(publicKey));
  const address = base58btc.encode(new Uint8Array([0x12, 0x20, ...hash])); // multihash prefix for SHA2-256
  return address;
};

// Simple hook for qbase auth state
export const useQbaseAuth = () => {
  const context = usePasskeysContext();
  
  const { currentPasskeyInfo, signWithPasskey: sdkSign } = context;
  
  const isAuthenticated = !!currentPasskeyInfo?.address;
  const address = currentPasskeyInfo?.address || null;
  const publicKey = currentPasskeyInfo?.publicKey || null;
  
  const signWithPasskey = async (payload: Uint8Array): Promise<Uint8Array> => {
    if (!currentPasskeyInfo?.credentialId) {
      throw new Error('Not authenticated with passkey');
    }
    
    // Ensure WASM is ready before signing
    await initQuilibriumWasm();
    
    // Convert Uint8Array to base64 string for SDK
    const payloadBase64 = btoa(String.fromCharCode(...payload));
    const signatureBase64 = await sdkSign(currentPasskeyInfo.credentialId, payloadBase64);
    
    // Convert base64 string back to Uint8Array
    const binary = atob(signatureBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  };
  
  return {
    isAuthenticated,
    isLoading: false,
    address,
    publicKey,
    signWithPasskey,
  };
};
