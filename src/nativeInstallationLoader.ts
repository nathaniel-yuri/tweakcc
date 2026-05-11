/**
 * Helper module for dynamically loading nativeInstallation.ts.
 *
 * nativeInstallation.ts depends on node-lief, which may not be available on all systems
 * (e.g., NixOS or systems without proper C++ libraries). This module provides a safe way
 * to dynamically import nativeInstallation.ts only when node-lief is available.
 */

import type {
  extractClaudeJsFromNativeInstallation as ExtractFn,
  repackNativeInstallation as RepackFn,
  resolveNixBinaryWrapper as ResolveNixFn,
} from './nativeInstallation';

import { extractClaudeJsFromBunBinary } from './bunBinary';
import { debug } from './utils';

interface NativeInstallationModule {
  extractClaudeJsFromNativeInstallation: typeof ExtractFn;
  repackNativeInstallation: typeof RepackFn;
  resolveNixBinaryWrapper: typeof ResolveNixFn;
}

let cachedModule: NativeInstallationModule | null = null;

/**
 * Attempts to load the nativeInstallation module.
 * Returns null if node-lief is not available.
 */
async function tryLoadNativeInstallationModule(): Promise<NativeInstallationModule | null> {
  if (cachedModule !== null) {
    return cachedModule;
  }

  try {
    // First check if node-lief is available
    await import('node-lief');
    // If it is, dynamically import the module that uses it
    cachedModule = await import('./nativeInstallation');
    return cachedModule;
  } catch (err) {
    debug(
      `Error loading native installation module: ${err instanceof Error ? err.message : String(err)}`
    );
    if (err instanceof Error) {
      debug(err);
    }
    // node-lief not available
    return null;
  }
}

/**
 * Extracts claude.js from a native installation binary.
 * Returns null if extraction fails (and node-lief is unavailable for the
 * fallback path).
 */
export async function extractClaudeJsFromNativeInstallation(
  nativeInstallationPath: string
): Promise<Buffer | null> {
  // Prefer the dependency-free `.bun` ELF section reader: LIEF's ELF parser
  // segfaults on patchelf-modified binaries (every Nix-store
  // `.claude-unwrapped`), so going through it on an installed binary crashes.
  // It only handles the modern `.bun`-section layout; Mach-O / PE / legacy
  // ELF-overlay binaries fall through to LIEF below, with identical output.
  const direct = extractClaudeJsFromBunBinary(nativeInstallationPath);
  if (direct) {
    return direct;
  }

  const mod = await tryLoadNativeInstallationModule();
  if (!mod) {
    return null;
  }
  return mod.extractClaudeJsFromNativeInstallation(nativeInstallationPath);
}

/**
 * Repacks a modified claude.js back into the native installation binary.
 * Unlike extraction, the write path has no node-lief-free alternative, so
 * this needs node-lief available even when extraction used the `.bun`-section
 * reader.
 */
export async function repackNativeInstallation(
  binPath: string,
  modifiedClaudeJs: Buffer,
  outputPath: string
): Promise<void> {
  const mod = await tryLoadNativeInstallationModule();
  if (!mod) {
    throw new Error(
      '`repackNativeInstallation()` called but `node-lief` is not available. ' +
        'Repacking a native binary requires node-lief.'
    );
  }
  mod.repackNativeInstallation(binPath, modifiedClaudeJs, outputPath);
}

/**
 * Detects whether a binary is a Nix `makeBinaryWrapper` wrapper and returns
 * the path to the real wrapped executable, or null if not a wrapper.
 * Returns null if node-lief is not available.
 */
export async function resolveNixBinaryWrapper(
  binaryPath: string
): Promise<string | null> {
  const mod = await tryLoadNativeInstallationModule();
  if (!mod) {
    return null;
  }
  return mod.resolveNixBinaryWrapper(binaryPath);
}
