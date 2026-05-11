/**
 * Dependency-free reader for Bun-compiled standalone binaries.
 *
 * Extracts the embedded entrypoint JS (Claude Code's `cli.js`) from a Bun
 * binary by reading the `.bun` ELF section straight from the file — no
 * node-lief. This exists because LIEF's ELF parser segfaults on binaries
 * whose program headers / `.interp` were rewritten by `patchelf
 * --set-interpreter`: that includes every Nix-store `.claude-unwrapped`
 * (claude-code-nix runs autoPatchelfHook on it) and every claude-code-tweakcc
 * output (it sets PT_INTERP itself), so `tweakcc unpack <installed-claude>`
 * crashes inside `LIEF.parse()`. LIEF parses the *unmodified* Bun binary
 * fine, so the build's own `--apply` pass (which runs on the pre-patchelf
 * binary) is unaffected — only the read side of `unpack` / `repack` /
 * `adhoc-patch` on an installed binary hits the crash.
 *
 * Only the modern `.bun` ELF section layout (Bun >= 1.3.x, post-PR#26923) is
 * handled here. Mach-O, PE, and the legacy ELF-overlay layout return null and
 * fall back to the LIEF path in nativeInstallation.ts. The Bun module-graph
 * parsing below mirrors the dependency-free helpers there; it is duplicated
 * rather than imported so this module never pulls in node-lief.
 */

import * as fs from 'node:fs';

import { debug } from './utils';

// ============================================================================
// ELF64 section reader
// ============================================================================

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // \x7fELF
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const ELF64_EHDR_SIZE = 64;
const ELF64_SHDR_SIZE = 64;
const SHN_UNDEF = 0;
const SHN_XINDEX = 0xffff;

interface Elf64SectionHeader {
  nameOffset: number;
  offset: number;
  size: number;
  link: number;
}

function readSectionHeader(buf: Buffer, at: number): Elf64SectionHeader {
  // Elf64_Shdr (64 bytes): sh_name u32 @0, sh_type u32 @4, sh_flags u64 @8,
  // sh_addr u64 @16, sh_offset u64 @24, sh_size u64 @32, sh_link u32 @40,
  // sh_info u32 @44, sh_addralign u64 @48, sh_entsize u64 @56.
  return {
    nameOffset: buf.readUInt32LE(at),
    offset: Number(buf.readBigUInt64LE(at + 24)),
    size: Number(buf.readBigUInt64LE(at + 32)),
    link: buf.readUInt32LE(at + 40),
  };
}

/**
 * Returns the raw bytes of the named section in an ELF64 little-endian file,
 * or null if the buffer is not such a file or has no section by that name.
 * Never throws.
 */
export function readElf64SectionByName(
  fileBuf: Buffer,
  name: string
): Buffer | null {
  try {
    if (
      fileBuf.length < ELF64_EHDR_SIZE ||
      !fileBuf.subarray(0, 4).equals(ELF_MAGIC) ||
      fileBuf.readUInt8(4) !== ELFCLASS64 ||
      fileBuf.readUInt8(5) !== ELFDATA2LSB
    ) {
      return null;
    }

    // Elf64_Ehdr: e_shoff u64 @0x28, e_shentsize u16 @0x3a, e_shnum u16 @0x3c,
    // e_shstrndx u16 @0x3e.
    const shoff = Number(fileBuf.readBigUInt64LE(0x28));
    const shentsize = fileBuf.readUInt16LE(0x3a);
    let shnum = fileBuf.readUInt16LE(0x3c);
    let shstrndx = fileBuf.readUInt16LE(0x3e);

    if (
      shoff === 0 ||
      shentsize !== ELF64_SHDR_SIZE ||
      shoff + ELF64_SHDR_SIZE > fileBuf.length
    ) {
      return null;
    }

    // e_shnum / e_shstrndx escape hatches for >= 0xff00 sections.
    const shdr0 = readSectionHeader(fileBuf, shoff);
    if (shnum === SHN_UNDEF) shnum = shdr0.size;
    if (shstrndx === SHN_XINDEX) shstrndx = shdr0.link;
    if (
      shnum === 0 ||
      shstrndx === 0 ||
      shstrndx >= shnum ||
      shoff + shnum * ELF64_SHDR_SIZE > fileBuf.length
    ) {
      return null;
    }

    const strtab = readSectionHeader(
      fileBuf,
      shoff + shstrndx * ELF64_SHDR_SIZE
    );
    if (strtab.offset + strtab.size > fileBuf.length) return null;
    const strtabBytes = fileBuf.subarray(
      strtab.offset,
      strtab.offset + strtab.size
    );

    const nameAt = (nameOffset: number): string => {
      if (nameOffset >= strtabBytes.length) return '';
      const end = strtabBytes.indexOf(0, nameOffset);
      return strtabBytes
        .subarray(nameOffset, end === -1 ? strtabBytes.length : end)
        .toString('latin1');
    };

    for (let i = 0; i < shnum; i++) {
      const sh = readSectionHeader(fileBuf, shoff + i * ELF64_SHDR_SIZE);
      if (nameAt(sh.nameOffset) !== name) continue;
      if (sh.offset + sh.size > fileBuf.length) return null;
      return fileBuf.subarray(sh.offset, sh.offset + sh.size);
    }
    return null;
  } catch (error) {
    debug('readElf64SectionByName: failed:', error);
    return null;
  }
}

// ============================================================================
// Bun module-graph parsing (mirrors nativeInstallation.ts; kept local so this
// module has no node-lief dependency)
// ============================================================================

const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const SIZEOF_OFFSETS = 32;
const SIZEOF_STRING_POINTER = 8;
const SIZEOF_MODULE_OLD = 4 * SIZEOF_STRING_POINTER + 4; // pre-ESM-bytecode Bun
const SIZEOF_MODULE_NEW = 6 * SIZEOF_STRING_POINTER + 4; // Bun ~1.3.7+

interface StringPointer {
  offset: number;
  length: number;
}

function readStringPointer(buf: Buffer, at: number): StringPointer {
  return { offset: buf.readUInt32LE(at), length: buf.readUInt32LE(at + 4) };
}

function sliceStringPointer(buf: Buffer, ptr: StringPointer): Buffer {
  return buf.subarray(ptr.offset, ptr.offset + ptr.length);
}

function isClaudeEntrypoint(moduleName: string): boolean {
  return (
    moduleName.endsWith('/claude') ||
    moduleName === 'claude' ||
    moduleName.endsWith('/claude.exe') ||
    moduleName === 'claude.exe' ||
    moduleName.endsWith('/src/entrypoints/cli.js') ||
    moduleName === 'src/entrypoints/cli.js'
  );
}

function detectModuleStructSize(modulesListLength: number): number {
  const fitsNew = modulesListLength % SIZEOF_MODULE_NEW === 0;
  const fitsOld = modulesListLength % SIZEOF_MODULE_OLD === 0;
  if (fitsOld && !fitsNew) return SIZEOF_MODULE_OLD;
  return SIZEOF_MODULE_NEW;
}

/**
 * Parses the raw `.bun` section content — `[u64 size][bun blob]` (Bun >=
 * 1.3.4) or `[u32 size][bun blob]` (Bun < 1.3.4), where `bun blob` is
 * `[data][modules table][offsets][trailer]` — and returns the embedded
 * Claude entrypoint module's JS, or null if the layout doesn't match.
 */
export function extractClaudeJsFromBunSection(
  sectionData: Buffer
): Buffer | null {
  if (sectionData.length < SIZEOF_STRING_POINTER) return null;

  const u32Size = sectionData.readUInt32LE(0);
  const u64Size = Number(sectionData.readBigUInt64LE(0));
  let headerSize: number;
  let blobSize: number;
  if (
    8 + u64Size <= sectionData.length &&
    8 + u64Size >= sectionData.length - 4096
  ) {
    headerSize = 8;
    blobSize = u64Size;
  } else if (
    4 + u32Size <= sectionData.length &&
    4 + u32Size >= sectionData.length - 4096
  ) {
    headerSize = 4;
    blobSize = u32Size;
  } else {
    return null;
  }

  const blob = sectionData.subarray(headerSize, headerSize + blobSize);
  if (blob.length < SIZEOF_OFFSETS + BUN_TRAILER.length) return null;
  if (!blob.subarray(blob.length - BUN_TRAILER.length).equals(BUN_TRAILER)) {
    return null;
  }

  // BunOffsets (32 bytes), just before the trailer: byteCount u64, modulesPtr
  // {u32 offset, u32 length}, entryPointId u32, compileExecArgvPtr {u32,u32},
  // flags u32. Only modulesPtr is needed.
  const offsetsAt = blob.length - SIZEOF_OFFSETS - BUN_TRAILER.length;
  const modulesPtr = readStringPointer(blob, offsetsAt + 8);

  const modulesList = sliceStringPointer(blob, modulesPtr);
  const moduleStructSize = detectModuleStructSize(modulesList.length);
  const moduleCount = Math.floor(modulesList.length / moduleStructSize);

  for (let i = 0; i < moduleCount; i++) {
    const base = i * moduleStructSize;
    // CompiledModuleGraphFile: name {u32,u32}, contents {u32,u32}, then more
    // pointers we don't need. name first, contents second.
    const namePtr = readStringPointer(modulesList, base);
    const contentsPtr = readStringPointer(
      modulesList,
      base + SIZEOF_STRING_POINTER
    );
    const moduleName = sliceStringPointer(blob, namePtr).toString('utf8');
    if (!isClaudeEntrypoint(moduleName)) continue;
    const contents = sliceStringPointer(blob, contentsPtr);
    return contents.length > 0 ? contents : null;
  }
  return null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Extracts the embedded Claude Code entrypoint JS from a Bun-compiled binary
 * by reading its `.bun` ELF section directly, without node-lief. Returns null
 * if `binaryPath` isn't an ELF64 Bun binary using the modern `.bun`-section
 * layout, or if anything about the layout looks off — callers fall back to the
 * LIEF-based path. Never throws.
 */
export function extractClaudeJsFromBunBinary(
  binaryPath: string
): Buffer | null {
  let fileBuf: Buffer;
  try {
    fileBuf = fs.readFileSync(binaryPath);
  } catch (error) {
    debug('extractClaudeJsFromBunBinary: read failed:', error);
    return null;
  }

  const section = readElf64SectionByName(fileBuf, '.bun');
  if (!section) {
    debug(`extractClaudeJsFromBunBinary: no .bun ELF section in ${binaryPath}`);
    return null;
  }

  const js = extractClaudeJsFromBunSection(section);
  if (!js) {
    debug(
      `extractClaudeJsFromBunBinary: .bun section in ${binaryPath} yielded no Claude entrypoint`
    );
    return null;
  }

  debug(
    `extractClaudeJsFromBunBinary: extracted ${js.length} bytes from ${binaryPath}`
  );
  return js;
}
