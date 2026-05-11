import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import {
  readElf64SectionByName,
  extractClaudeJsFromBunSection,
  extractClaudeJsFromBunBinary,
} from '../bunBinary';

// ============================================================================
// Minimal ELF64 fixture builder
// ============================================================================

const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');

/** Builds a string-table buffer plus the offset of each name within it. */
function buildStrtab(names: string[]): { bytes: Buffer; offsets: number[] } {
  const parts: Buffer[] = [Buffer.from([0])];
  const offsets: number[] = [];
  let pos = 1;
  for (const name of names) {
    offsets.push(pos);
    const b = Buffer.from(name + '\0', 'latin1');
    parts.push(b);
    pos += b.length;
  }
  return { bytes: Buffer.concat(parts), offsets };
}

/**
 * Builds a tiny but well-formed ELF64 little-endian file containing exactly the
 * given sections (plus the mandatory null section and a trailing `.shstrtab`).
 */
function buildElf64(sections: { name: string; content: Buffer }[]): Buffer {
  const SHDR = 64;
  const strtab = buildStrtab([...sections.map(s => s.name), '.shstrtab']);
  const shstrtabNameOff = strtab.offsets[strtab.offsets.length - 1];

  const sectionCount = sections.length + 2; // null + sections... + .shstrtab
  const shoff = SHDR; // section header table immediately after the ELF header
  let cursor = shoff + sectionCount * SHDR;

  const strtabOff = cursor;
  cursor += strtab.bytes.length;

  const placed = sections.map((s, i) => {
    const off = cursor;
    cursor += s.content.length;
    return { ...s, off, nameOff: strtab.offsets[i] };
  });

  const buf = Buffer.alloc(cursor);

  // ELF64 header.
  buf.set([0x7f, 0x45, 0x4c, 0x46], 0); // \x7fELF
  buf.writeUInt8(2, 4); // EI_CLASS = ELFCLASS64
  buf.writeUInt8(1, 5); // EI_DATA = ELFDATA2LSB
  buf.writeUInt8(1, 6); // EI_VERSION
  buf.writeUInt16LE(2, 16); // e_type = ET_EXEC
  buf.writeUInt16LE(0x3e, 18); // e_machine = EM_X86_64
  buf.writeUInt32LE(1, 20); // e_version
  buf.writeBigUInt64LE(BigInt(shoff), 0x28); // e_shoff
  buf.writeUInt16LE(64, 0x34); // e_ehsize
  buf.writeUInt16LE(SHDR, 0x3a); // e_shentsize
  buf.writeUInt16LE(sectionCount, 0x3c); // e_shnum
  buf.writeUInt16LE(sectionCount - 1, 0x3e); // e_shstrndx (the .shstrtab)

  const writeShdr = (
    idx: number,
    fields: { nameOff: number; off: number; size: number; type: number }
  ) => {
    const at = shoff + idx * SHDR;
    buf.writeUInt32LE(fields.nameOff, at + 0);
    buf.writeUInt32LE(fields.type, at + 4);
    buf.writeBigUInt64LE(BigInt(fields.off), at + 24);
    buf.writeBigUInt64LE(BigInt(fields.size), at + 32);
  };

  // shdr[0] is the mandatory SHT_NULL entry (left zeroed).
  placed.forEach((s, i) => {
    writeShdr(i + 1, {
      nameOff: s.nameOff,
      off: s.off,
      size: s.content.length,
      type: 1, // SHT_PROGBITS
    });
    buf.set(s.content, s.off);
  });
  writeShdr(sectionCount - 1, {
    nameOff: shstrtabNameOff,
    off: strtabOff,
    size: strtab.bytes.length,
    type: 3, // SHT_STRTAB
  });
  buf.set(strtab.bytes, strtabOff);

  return buf;
}

/** Builds raw `.bun` section content embedding a single named JS module. */
function buildBunSection(moduleName: string, contents: Buffer): Buffer {
  const nameBytes = Buffer.from(moduleName, 'utf8');
  const data = Buffer.concat([nameBytes, contents]);

  // 36-byte CompiledModuleGraphFile (old layout): name{u32 off, u32 len},
  // contents{u32,u32}, sourcemap{0,0}, bytecode{0,0}, 4 trailing bytes.
  const moduleEntry = Buffer.alloc(36);
  moduleEntry.writeUInt32LE(0, 0); // name offset
  moduleEntry.writeUInt32LE(nameBytes.length, 4); // name length
  moduleEntry.writeUInt32LE(nameBytes.length, 8); // contents offset
  moduleEntry.writeUInt32LE(contents.length, 12); // contents length

  const modulesOff = data.length;
  const blobBeforeOffsets = Buffer.concat([data, moduleEntry]);

  // 32-byte BunOffsets: byteCount u64, modulesPtr{u32 off, u32 len},
  // entryPointId u32, compileExecArgvPtr{u32,u32}, flags u32.
  const bunOffsets = Buffer.alloc(32);
  bunOffsets.writeUInt32LE(modulesOff, 8); // modulesPtr.offset
  bunOffsets.writeUInt32LE(moduleEntry.length, 12); // modulesPtr.length

  const blob = Buffer.concat([blobBeforeOffsets, bunOffsets, BUN_TRAILER]);
  const header = Buffer.alloc(8);
  header.writeBigUInt64LE(BigInt(blob.length), 0);
  return Buffer.concat([header, blob]);
}

// ============================================================================
// Tests
// ============================================================================

describe('readElf64SectionByName', () => {
  it('returns the bytes of a named section', () => {
    const fooBytes = Buffer.from(
      'hello bun!\x00\x01\x02\x03\x04\x05',
      'latin1'
    );
    const elf = buildElf64([{ name: '.foo', content: fooBytes }]);
    expect(readElf64SectionByName(elf, '.foo')).toEqual(fooBytes);
  });

  it('returns null for a missing section', () => {
    const elf = buildElf64([{ name: '.foo', content: Buffer.from('x') }]);
    expect(readElf64SectionByName(elf, '.bun')).toBeNull();
  });

  it('returns null for non-ELF, empty, and non-64-bit input', () => {
    expect(
      readElf64SectionByName(Buffer.from('not an elf at all'), '.foo')
    ).toBeNull();
    expect(readElf64SectionByName(Buffer.alloc(0), '.foo')).toBeNull();
    const elf32 = buildElf64([{ name: '.foo', content: Buffer.from('x') }]);
    elf32.writeUInt8(1, 4); // EI_CLASS = ELFCLASS32
    expect(readElf64SectionByName(elf32, '.foo')).toBeNull();
  });
});

describe('extractClaudeJsFromBunSection', () => {
  it('extracts the Claude entrypoint module from a `.bun` section', () => {
    const js = Buffer.from('console.log("hi from cli.js");', 'utf8');
    const section = buildBunSection('/$bunfs/root/src/entrypoints/cli.js', js);
    expect(extractClaudeJsFromBunSection(section)).toEqual(js);
  });

  it('returns null when no module is the Claude entrypoint', () => {
    const section = buildBunSection(
      '/$bunfs/root/some/other.js',
      Buffer.from('x')
    );
    expect(extractClaudeJsFromBunSection(section)).toBeNull();
  });

  it('returns null on a corrupted trailer', () => {
    const section = buildBunSection(
      '/$bunfs/root/src/entrypoints/cli.js',
      Buffer.from('x')
    );
    section[section.length - 1] = 0x00; // corrupt the trailer
    expect(extractClaudeJsFromBunSection(section)).toBeNull();
  });
});

describe('extractClaudeJsFromBunBinary', () => {
  let tmpFiles: string[] = [];

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fsSync.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    tmpFiles = [];
  });

  it('extracts the entrypoint from an ELF64 binary with a `.bun` section', () => {
    const js = Buffer.from('console.log("end-to-end");', 'utf8');
    const elf = buildElf64([
      {
        name: '.bun',
        content: buildBunSection('/$bunfs/root/src/entrypoints/cli.js', js),
      },
    ]);
    const tmp = path.join(os.tmpdir(), `tweakcc-bunBinary-${process.pid}.bin`);
    tmpFiles.push(tmp);
    fsSync.writeFileSync(tmp, elf);
    expect(extractClaudeJsFromBunBinary(tmp)).toEqual(js);
  });

  it('returns null (no throw) on a non-existent path', () => {
    expect(
      extractClaudeJsFromBunBinary('/definitely/not/a/real/path/claude')
    ).toBeNull();
  });
});
