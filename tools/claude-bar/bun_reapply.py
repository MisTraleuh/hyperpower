#!/usr/bin/env python3
"""
bun_reapply.py - VERSION-AGNOSTIC daily-reapply tool for Claude Code.

Injects TWO length-changing edits into the embedded JS source of the Bun-compiled
standalone macOS `claude` binary, producing a VERIFIED patched COPY (never touching
the live binary or ~/.local/...):

  1) BAR   - an animated per-agent progress bar in the /workflows panel row
             (component xBl / "v0l"). Fixed display width 13 ("[" + 10 glyphs +
             "]" + space). State is read from the build's own status helper
             (captured per-version), falling back to the agent object's `.state`.
             Glyphs are ASCII \\uXXXX escapes (raw UTF-8 mojibakes in this bundle).
  2) BADGE - a Codex-aware model badge: overrides the model variable so that when
             the agent's `.label` looks like "(codex ... )" it renders "Codex <m>"
             or "(via Codex)" instead of the raw model name.

Both edit sites are located by STRUCTURAL regex that CAPTURES the minified
identifiers per-version (they churn between builds; nothing is hardcoded). Every
Mach-O / Bun-graph constant is DERIVED from the binary (see derive_constants).

SAFE-DEGRADE: if any step fails (symlink resolve, derive, a regex that does not
match EXACTLY once, a replacement that fails `node --check`, an apply error, the
patched copy not launching, or codesign verify failing) the tool ABORTS cleanly,
prints exactly what failed, and does NOT leave a broken output behind.

=============================================================================
LAYOUT (recap, derived not hardcoded)
=============================================================================
  LC_SEGMENT_64 segname=__BUN  -> fileoff, filesize  (DERIVED)
    section sectname=__bun     -> the u64 `size` field FILE OFFSET (DERIVED)
  BlobHeader: [u64 blob_length] at section fileoff; DATA = fileoff + 8.
  Graph data ends with trailer magic b"\\n---- Bun! ----\\n".
  Immediately before the trailer: 32-byte Offsets struct.
  Module array: array of 52-byte CompiledModuleGraphFile entries; StringPointers
  at byte positions {0,8,16,24,32} inside each entry.
"""

import re
import struct
import subprocess
import sys
import os
import shutil
import tempfile

# ---- Mach-O constants -------------------------------------------------------
MH_MAGIC_64    = 0xFEEDFACF
FAT_MAGIC      = 0xCAFEBABE
FAT_MAGIC_64   = 0xCAFEBABF
LC_SEGMENT_64  = 0x19

CPU_TYPE_X86_64 = 0x01000007
CPU_TYPE_ARM64  = 0x0100000C

# ---- Bun graph constants ----------------------------------------------------
TRAILER           = b"\n---- Bun! ----\n"   # 16 bytes
MODULE_ENTRY_SIZE = 52
OFFSETS_SIZE      = 32
SP_POSITIONS      = (0, 8, 16, 24, 32)   # StringPointer byte positions per module entry


class ReapplyError(RuntimeError):
    """Raised on any unrecoverable condition; main() turns this into a clean abort."""


# ----------------------------- little helpers --------------------------------
def _u32(buf, off):
    return struct.unpack_from("<I", buf, off)[0]


def _u64(buf, off):
    return struct.unpack_from("<Q", buf, off)[0]


def _set_u32(buf, off, val):
    struct.pack_into("<I", buf, off, val & 0xFFFFFFFF)


def _set_u64(buf, off, val):
    struct.pack_into("<Q", buf, off, val)


# ----------------------------- Mach-O parsing --------------------------------
def _macho_slice_base(buf):
    if len(buf) < 4:
        raise ReapplyError("file too small")
    be_magic = struct.unpack_from(">I", buf, 0)[0]
    le_magic = struct.unpack_from("<I", buf, 0)[0]

    if le_magic == MH_MAGIC_64:
        return 0

    if be_magic in (FAT_MAGIC, FAT_MAGIC_64):
        is64 = be_magic == FAT_MAGIC_64
        nfat = struct.unpack_from(">I", buf, 4)[0]
        arch_off = 8
        chosen = None
        first64 = None
        for _ in range(nfat):
            if is64:
                cputype, _cpusub, offset, size, _align, _res = struct.unpack_from(">iiQQII", buf, arch_off)
                arch_off += 32
            else:
                cputype, _cpusub, offset, size, _align = struct.unpack_from(">iiIII", buf, arch_off)
                arch_off += 20
            cput = cputype & 0xFFFFFFFF
            if struct.unpack_from("<I", buf, offset)[0] == MH_MAGIC_64:
                if first64 is None:
                    first64 = offset
                if cput == CPU_TYPE_ARM64:
                    chosen = offset
        base = chosen if chosen is not None else first64
        if base is None:
            raise ReapplyError("no 64-bit Mach-O slice found in FAT binary")
        return base

    raise ReapplyError(
        "unrecognized magic 0x%08X (not a 64-bit Mach-O or FAT image)" % be_magic
    )


def parse_macho(buf):
    base = _macho_slice_base(buf)

    magic = _u32(buf, base + 0)
    if magic != MH_MAGIC_64:
        raise ReapplyError("slice at 0x%X is not MH_MAGIC_64 (got 0x%08X)" % (base, magic))

    cputype = _u32(buf, base + 4)
    ncmds   = _u32(buf, base + 16)
    lc = base + 32

    bun = None
    for _ in range(ncmds):
        cmd     = _u32(buf, lc + 0)
        cmdsize = _u32(buf, lc + 4)
        if cmdsize == 0:
            raise ReapplyError("zero-size load command; parse aborted")
        if cmd == LC_SEGMENT_64:
            segname = bytes(buf[lc + 8: lc + 24]).split(b"\x00", 1)[0]
            if segname == b"__BUN":
                seg_vmsize   = _u64(buf, lc + 32)
                seg_fileoff  = _u64(buf, lc + 40)
                seg_filesize = _u64(buf, lc + 48)
                nsects       = _u32(buf, lc + 64)
                sect = lc + 72
                target = None
                for _s in range(nsects):
                    sectname = bytes(buf[sect + 0: sect + 16]).split(b"\x00", 1)[0]
                    if sectname == b"__bun":
                        sect_size_val   = _u64(buf, sect + 40)
                        sect_fileoff    = _u32(buf, sect + 48)
                        target = {
                            "sect_size": sect_size_val,
                            "sect_size_field_off": sect + 40,  # absolute (base already added)
                            "sect_fileoff": sect_fileoff,
                        }
                        break
                    sect += 80
                if target is None:
                    raise ReapplyError("__BUN segment has no __bun section")
                bun = {
                    "bun_seg_fileoff": seg_fileoff,
                    "bun_seg_filesize": seg_filesize,
                    "bun_seg_vmsize": seg_vmsize,
                    **target,
                }
        lc += cmdsize

    if bun is None:
        raise ReapplyError("__BUN segment not found in load commands")

    bun["base"] = base
    bun["cputype"] = cputype
    return bun


# --------------------------- derive_constants --------------------------------
def derive_constants(binary_path):
    with open(binary_path, "rb") as f:
        buf = bytearray(f.read())

    m = parse_macho(buf)

    section_fileoff = m["sect_fileoff"]
    seg_fileoff     = m["bun_seg_fileoff"]
    seg_filesize    = m["bun_seg_filesize"]
    seg_file_end    = seg_fileoff + seg_filesize

    blob_len  = _u64(buf, section_fileoff)
    sect_size = _u64(buf, m["sect_size_field_off"])

    win_start = max(seg_fileoff, seg_file_end - 1_000_000)
    idx = buf.rfind(TRAILER, win_start, seg_file_end)
    if idx < 0:
        idx = buf.rfind(TRAILER, seg_fileoff, seg_file_end)
    if idx < 0:
        raise ReapplyError("Bun trailer magic not found inside __BUN segment")

    trailer_abs = idx
    data_end    = trailer_abs + len(TRAILER)
    offsets_abs = trailer_abs - OFFSETS_SIZE
    padding     = seg_file_end - data_end

    return {
        "SECTION_FILEOFF": section_fileoff,
        "DATA": section_fileoff + 8,
        "SECTION_SIZE_FIELD": m["sect_size_field_off"],
        "SEGMENT_FILESIZE": seg_filesize,
        "SEG_FILE_END": seg_file_end,
        "blob_len": blob_len,
        "sect_size": sect_size,
        "trailer_abs": trailer_abs,
        "data_end": data_end,
        "offsets_abs": offsets_abs,
        "padding": padding,
        "cputype": m["cputype"],
        "base": m["base"],
    }


# ----------------------------- find_edit_sites -------------------------------
# Both edits live in the /workflows panel row component (xBl in 2.1.191, "v0l"
# historically). Minified identifiers change between builds, so match
# STRUCTURALLY and CAPTURE per-version. Each must match EXACTLY once.

# BAR (at the component return). PRISTINE form:
#   return[{text:c,color:i,dimColor:a},{text:" ".repeat(p)},{text:u,color:i,dimColor:a}]
# captures: 1=MODEL 2=COL 3=DIM 4=GAP 5=STATS
BAR_RE = re.compile(
    rb'return\[\{text:(\w{1,3}),color:(\w{1,3}),dimColor:(\w{1,3})\},'
    rb'\{text:" "\.repeat\((\w{1,3})\)\},'
    rb'\{text:(\w{1,3}),color:\2,dimColor:\3\}\]'
)

# BADGE (the model/stats local assignment just before the return). PRISTINE form:
#   l=(m,f)=>f<=0?"":xs(m,f),c=o,u=s,
# captures: 1=L 2=M 3=F 4=CLIPHELPER 5=CVAR 6=MODELSRC 7=UVAR 8=STATSSRC
BADGE_RE = re.compile(
    rb'(\w{1,3})=\((\w{1,3}),(\w{1,3})\)=>\3<=0\?"":(\w{1,4})\(\2,\3\),'
    rb'(\w{1,3})=(\w{1,3}),(\w{1,3})=(\w{1,3}),'
)

# status helper used by the row to map an agent object -> status string.
# 2.1.190/191: function ILe(e,t){...return ...}. Capture its name so we can call
# it; but we DON'T hard-depend on it (the bar has a .state fallback).
STATUS_FN_RE = re.compile(
    rb'function (\w{1,4})\(\w{1,3},\w{1,3}\)\{if\(\w{1,3}\.state==="done"\)return"done";'
)

# ACTIVITY cap: the drill-in detail view shows only the last N tool calls. We find
# the cap var from the "Activity" render usage (stable English text) then bump its
# definition `<cap>=3,` -> `<cap>=99,` so ~all activity shows.
ACT_USAGE_RE = re.compile(
    rb'"Activity",bold:!0,dimColor:!0\},\.\.\.(\w{1,4})\.length>(\w{1,4})\?'
)

# OUTCOME (done case): the agent result is rendered raw. We wrap its initializer so
# JSON output is pretty-printed before line-wrapping. Field names finalText/
# resultPreview are stable (data fields, not minified). Captures: 1=y 2=n 3=n 4=n 5=e
OUT_RE = re.compile(
    rb'let (\w{1,3})=(\w{1,3})!=="loading"&&(\w{1,3})\?\.finalText\?(\w{1,3})\.finalText:(\w{1,3})\.resultPreview\?\?""'
)


def _find_one(regex, data, what):
    matches = list(regex.finditer(data))
    if len(matches) != 1:
        raise ReapplyError(
            "%s regex matched %d times (expected exactly 1)" % (what, len(matches))
        )
    return matches[0]


def find_bar_site(data):
    m = _find_one(BAR_RE, data, "BAR")
    names = {
        "model":    m.group(1).decode("latin-1"),
        "color":    m.group(2).decode("latin-1"),
        "dimColor": m.group(3).decode("latin-1"),
        "spacer":   m.group(4).decode("latin-1"),
        "stats":    m.group(5).decode("latin-1"),
    }
    return m.start(), m.group(0), names


def find_badge_site(data):
    m = _find_one(BADGE_RE, data, "BADGE")
    names = {
        "cliphelper": m.group(1).decode("latin-1"),  # l
        "clipfn":     m.group(4).decode("latin-1"),  # xs/Os
        "cvar":       m.group(5).decode("latin-1"),  # c
        "modelsrc":   m.group(6).decode("latin-1"),  # o
        "uvar":       m.group(7).decode("latin-1"),  # u
        "statssrc":   m.group(8).decode("latin-1"),  # s
    }
    return m.start(), m.group(0), names


def find_activity_edit(data):
    """Return (offset, old_bytes, new_bytes) raising the Activity cap 3 -> 99."""
    m = _find_one(ACT_USAGE_RE, data, "ACTIVITY")
    cap = m.group(2)  # the cap var, e.g. b'_Lo'
    old = cap + b'=3,'
    if data.count(old) != 1:
        raise ReapplyError("activity cap def %r not unique (%d)" % (old, data.count(old)))
    new = cap + b'=99,'
    return data.find(old), old, new


def find_outcome_edit(data):
    """Return (offset, old_bytes, new_bytes) replacing the done-result initializer
    with a JSON *viewer* (not just raw pretty-print):

      - objects render one `key: value` per line, keys UNQUOTED, 2-space indent/depth
      - booleans render as glyphs: true -> check (\\u2713), false -> cross (\\u2717)
        so `accepted: true` reads `accepted: ✓`
      - arrays render one `- item` per line; nested objects/arrays indent under a
        bare `key:` / `-` header
      - empty containers render `[]` / `{}` / `(empty)`

    Falls back to the raw text when the payload is not JSON (parse throws or the
    trimmed text does not start with `{`/`[`). Glyphs are literal \\uXXXX escapes
    (raw UTF-8 mojibakes in this Bun bundle). Stays a single `let Y=(()=>{...})()`
    IIFE so the downstream `nqo(Y,l)` line-wrap is untouched."""
    m = _find_one(OUT_RE, data, "OUTCOME")
    y, n, e = m.group(1), m.group(3), m.group(5)
    old = m.group(0)
    Y, N, E = y.decode("latin-1"), n.decode("latin-1"), e.decode("latin-1")
    new = (
        "let " + Y + "=(()=>{"
        "let __r=" + N + '!=="loading"&&' + N + "?.finalText?" + N +
        ".finalText:" + E + '.resultPreview??"";'
        'let __ck="\\u2713",__cx="\\u2717";'
        'let __io=(v)=>v!==null&&typeof v==="object";'
        'let __ne=(v)=>Array.isArray(v)?v.length>0:Object.keys(v).length>0;'
        'let __sc=(v)=>v===null?"null":typeof v==="boolean"?(v?__ck:__cx):'
        'typeof v==="string"?v:Array.isArray(v)?"[]":typeof v==="object"?"{}":String(v);'
        'let __ln=(v,ind)=>{let pad="  ".repeat(ind),out=[];'
        'if(Array.isArray(v)){if(!v.length){out.push(pad+"(empty)");return out}'
        'for(let it of v){if(__io(it)&&__ne(it)){out.push(pad+"-");'
        'for(let l of __ln(it,ind+1))out.push(l)}else out.push(pad+"- "+__sc(it))}}'
        'else if(__io(v)){let ks=Object.keys(v);if(!ks.length){out.push(pad+"(empty)");return out}'
        'for(let k of ks){let val=v[k];'
        'if(__io(val)&&__ne(val)){out.push(pad+k+":");for(let l of __ln(val,ind+1))out.push(l)}'
        'else out.push(pad+k+": "+__sc(val))}}'
        'else out.push(pad+__sc(v));return out};'
        'try{if(typeof __r==="string"){let __t=__r.trim();'
        'if(__t[0]==="{"||__t[0]==="["){return __ln(JSON.parse(__t),0).join("\\n")}}}catch(__e){}'
        "return __r})()"
    ).encode("latin-1")
    return m.start(), old, new


def find_status_fn(data):
    """Return the captured status-helper name (e.g. 'ILe') or None if not found.
    Optional: the bar degrades to reading the agent's `.state` directly when None.
    """
    matches = list(STATUS_FN_RE.finditer(data))
    if len(matches) == 1:
        return matches[0].group(1).decode("latin-1")
    return None


# --------------------------- replacement builders ----------------------------
# Glyphs MUST be written into the bundle as the LITERAL ASCII escape sequences
# (e.g. the 6 chars  \ u 2 5 B 0), NOT as UTF-8 bytes: raw UTF-8 renders as
# mojibake in this Bun bundle (confirmed). The JS engine decodes \uXXXX at parse
# time so the rendered output is the real glyph.
G_FULL  = r"\u25B0"   # the 6 ASCII chars  backslash u 2 5 B 0  -> renders as filled glyph
G_EMPTY = r"\u25B1"   # empty glyph
G_CROSS = r"\u2717"   # ballot X
# Each bar is exactly 13 display columns: "[" + 10 inner glyphs + "]" + " ".
BAR_DONE   = "[" + G_FULL * 10 + "] "
BAR_FAIL   = "[" + G_FULL * 2 + " " * 7 + G_CROSS + "] "   # 2 filled + 7 spaces + cross = 10 inner
BAR_EMPTY  = "[" + G_EMPTY * 10 + "] "


def build_bar_replacement(names, status_fn):
    """Build the BAR return replacement (a length-changing edit).

    Drops the old `sn(...)`-style spacer arithmetic: the bar is a fixed 13 cols,
    so the spacer is `" ".repeat(Math.max(0, GAP-13))`.

    State: prefer the build's captured status helper (e.g. ILe(e,r)); if absent or
    it throws, fall back to mapping the agent object's `.state` field directly.
    The agent object is the row component's first param `e`; the helper's 2nd arg
    matches the component's 4th param `r` (same as the internal _xm(e,r) call).
    """
    MODEL = names["model"]
    COL   = names["color"]
    DIM   = names["dimColor"]
    GAP   = names["spacer"]
    STATS = names["stats"]

    if status_fn:
        state_expr = (
            '(()=>{try{return %s(e,r)}catch(_){'
            'return e&&e.state==="done"?"done":e&&e.state==="error"?"failed":"running"}})()'
            % status_fn
        )
    else:
        # No helper captured: derive a status string from .state directly.
        state_expr = (
            '(()=>{let __x=e&&e.state;'
            'return __x==="done"?"done":__x==="error"?"failed":'
            '(__x==="queued"||__x==="interrupted"||__x==="skipped")?"queued":"running"})()'
        )

    js = (
        'let __st=' + state_expr + ',__bar;'
        # Crash-vs-clean: a (codex) node that hit its usage/rate limit still
        # *completes* (the subagent returns a schema), so state==="done" and the row
        # would show a healthy full bar. Inspect the agent's result text for the
        # deterministic Codex error markers (relayed verbatim from the codex CLI) and
        # downgrade to "failed" so the row shows the cross. Bare "error" is NOT a
        # marker (avoids false positives on prose that merely mentions errors).
        'if(__st==="done"){let __rp=(e&&(e.resultPreview||e.finalText))||"";'
        'if(typeof __rp==="string"&&'
        '/usage limit|rate limit|codex exec returned ERROR|codex-not-installed|ERROR \\u2014 Codex/i'
        '.test(__rp))__st="failed";}'
        'if(__st==="done")__bar="' + BAR_DONE + '";'
        'else if(__st==="failed")__bar="' + BAR_FAIL + '";'
        'else if(__st==="running"){'
        'let __fr=Math.floor(Date.now()/250)%10,__s="";'
        'for(let __k=0;__k<10;__k++)__s+=(__k<=__fr?"' + G_FULL + '":"' + G_EMPTY + '");'
        '__bar="["+__s+"] ";}'
        'else __bar="' + BAR_EMPTY + '";'
        'return[{text:' + MODEL + ',color:' + COL + ',dimColor:' + DIM + '},'
        '{text:" ".repeat(Math.max(0,' + GAP + '-13))},'
        '{text:__bar+' + STATS + ',color:' + COL + ',dimColor:' + DIM + '}]'
    )
    return js.encode("latin-1")


def build_badge_replacement(names):
    """Build the BADGE replacement: override `c=o` (model var) with a codex-aware
    IIFE that inspects the agent's `.label`. Keeps the trailing `u=s,` intact so
    the surrounding statement list is preserved byte-for-byte except for `c=o`.

    Old:  l=(m,f)=>f<=0?"":xs(m,f),c=o,u=s,
    New:  l=(m,f)=>f<=0?"":xs(m,f),c=(()=>{...})(),u=s,
    """
    L     = names["cliphelper"]
    M     = "m"  # the clip helper's own params are literal m,f in the source
    F     = "f"
    CLIP  = names["clipfn"]
    CVAR  = names["cvar"]
    MSRC  = names["modelsrc"]
    UVAR  = names["uvar"]
    SSRC  = names["statssrc"]

    # Re-emit the captured clip helper verbatim (using its real param names) then
    # the codex override for c, then u=s,. We rebuild from captured group names so
    # the bytes line up exactly with the matched old_bytes.
    # The clip helper params were captured as group2/group3 in BADGE_RE; rebuild
    # using those exact names to guarantee an exact old-string match composition.
    badge = (
        CVAR + '=(()=>{'
        'let g=typeof e?.label=="string"'
        '?e.label.match(/\\(codex(?:[\\s\\u00B7:\\-]+([\\w.\\-]+))?\\)/):null;'
        'return g?(g[1]?"Codex "+g[1]:"(via Codex)"):' + MSRC + '})()'
    )
    return badge.encode("latin-1")


# ------------------------------- patcher -------------------------------------
def patch(src_path, out_path, edit_file_offset, old_bytes, new_bytes, C, sign=True):
    """Apply a (possibly length-changing) edit using DERIVED constants `C`.
    Absorb-into-padding + StringPointer fixup. Writes out_path. Re-signs iff sign.
    """
    if isinstance(old_bytes, str):
        old_bytes = old_bytes.encode("latin-1")
    if isinstance(new_bytes, str):
        new_bytes = new_bytes.encode("latin-1")

    SECTION_FILEOFF    = C["SECTION_FILEOFF"]
    DATA               = C["DATA"]
    SECTION_SIZE_FIELD = C["SECTION_SIZE_FIELD"]
    SEG_FILE_END       = C["SEG_FILE_END"]

    with open(src_path, "rb") as f:
        buf = bytearray(f.read())

    delta = len(new_bytes) - len(old_bytes)

    actual = bytes(buf[edit_file_offset:edit_file_offset + len(old_bytes)])
    if actual != old_bytes:
        raise ReapplyError(
            "old_bytes mismatch at offset %d:\n  expected %r\n  found    %r"
            % (edit_file_offset, old_bytes, actual)
        )
    if not (DATA <= edit_file_offset):
        raise ReapplyError("edit offset is before the graph data start")

    edit_graph_off = edit_file_offset - DATA

    win_start = max(SECTION_FILEOFF, SEG_FILE_END - 1_000_000)
    trailer_abs = buf.rfind(TRAILER, win_start, SEG_FILE_END)
    if trailer_abs < 0:
        trailer_abs = buf.rfind(TRAILER, SECTION_FILEOFF, SEG_FILE_END)
    if trailer_abs < 0:
        raise ReapplyError("Bun trailer magic not found")
    data_end    = trailer_abs + len(TRAILER)
    offsets_abs = trailer_abs - OFFSETS_SIZE

    if edit_file_offset + len(old_bytes) > offsets_abs:
        raise ReapplyError("edit overlaps the Offsets/trailer region")

    padding = SEG_FILE_END - data_end
    if delta > padding:
        raise ReapplyError(
            "delta %d exceeds available trailing padding %d (would need to grow "
            "__LINKEDIT; not supported by absorb-into-padding)" % (delta, padding)
        )

    blob_len  = _u64(buf, SECTION_FILEOFF)
    sect_size = _u64(buf, SECTION_SIZE_FIELD)

    off_byte_count   = _u64(buf, offsets_abs + 0)
    off_modules_off  = _u32(buf, offsets_abs + 8)
    off_modules_len  = _u32(buf, offsets_abs + 12)
    off_argv_off     = _u32(buf, offsets_abs + 20)

    modules_abs  = DATA + off_modules_off
    module_count = off_modules_len // MODULE_ENTRY_SIZE

    edit_end = edit_file_offset + len(old_bytes)
    head    = buf[:edit_file_offset]
    middle  = buf[edit_end:data_end]
    seg_pad = buf[data_end:SEG_FILE_END]
    rest    = buf[SEG_FILE_END:]

    new_pad_len = len(seg_pad) - delta
    if new_pad_len < 0:
        raise ReapplyError("internal: negative padding")
    new_pad = bytes(new_pad_len)

    newbuf = bytearray()
    newbuf += head
    newbuf += new_bytes
    newbuf += middle
    newbuf += new_pad
    newbuf += rest

    if len(newbuf) != len(buf):
        raise ReapplyError("internal: file size changed (%d -> %d)" % (len(buf), len(newbuf)))

    offsets_abs_new = offsets_abs + delta
    modules_abs_new = modules_abs + delta

    _set_u64(newbuf, SECTION_FILEOFF, blob_len + delta)
    _set_u64(newbuf, SECTION_SIZE_FIELD, sect_size + delta)

    _set_u64(newbuf, offsets_abs_new + 0, off_byte_count + delta)
    if off_modules_off >= edit_graph_off:
        _set_u32(newbuf, offsets_abs_new + 8, off_modules_off + delta)
    if off_argv_off >= edit_graph_off:
        _set_u32(newbuf, offsets_abs_new + 20, off_argv_off + delta)

    graph_len_before_offsets = off_byte_count
    fixed_shift = 0
    fixed_grow = 0
    for i in range(module_count):
        ent = modules_abs_new + i * MODULE_ENTRY_SIZE
        for sp in SP_POSITIONS:
            sp_off_pos = ent + sp
            sp_offset = _u32(newbuf, sp_off_pos)
            sp_length = _u32(newbuf, sp_off_pos + 4)
            if sp_length == 0:
                continue
            sp_end = sp_offset + sp_length
            if sp_end > graph_len_before_offsets:
                continue
            if sp_offset >= edit_graph_off:
                _set_u32(newbuf, sp_off_pos, sp_offset + delta)
                fixed_shift += 1
            elif sp_end > edit_graph_off:
                _set_u32(newbuf, sp_off_pos + 4, sp_length + delta)
                fixed_grow += 1

    with open(out_path, "wb") as f:
        f.write(newbuf)

    subprocess.run(["chmod", "+x", out_path], check=True)
    if sign:
        res = subprocess.run(
            ["codesign", "-f", "-s", "-", out_path],
            capture_output=True, text=True
        )
        if res.returncode != 0:
            raise ReapplyError("codesign failed: %s" % res.stderr)

    return {
        "delta": delta,
        "edit_graph_off": edit_graph_off,
        "module_count": module_count,
        "string_pointers_shifted": fixed_shift,
        "string_pointers_grown": fixed_grow,
        "blob_len_new": blob_len + delta,
        "section_size_new": sect_size + delta,
        "padding_old": padding,
        "padding_new": new_pad_len,
        "out_path": out_path,
    }


# ----------------------------- JS syntax check -------------------------------
def syntax_check_js(snippet_bytes, kind):
    """Wrap an edit's replacement JS into a parseable scaffold and run
    `node --check`. Aborts (ReapplyError) if the snippet is not valid JS.

    The replacements are statement fragments that reference identifiers from the
    surrounding minified function; we wrap them in a function that declares those
    names so `node --check` only validates SYNTAX, not resolution.
    """
    snip = snippet_bytes.decode("latin-1")
    if kind == "bar":
        # bar is a list of statements ending in `return [...]`
        wrapper = (
            "function ILe(e,r){return 'running'}\n"
            "function __wrap(e,t,n,r){let c,i,a,p,u,o,s;c=o;u=s;\n"
            + snip + "\n}\n"
        )
    elif kind == "badge":
        # badge is `c=(()=>{...})()` -> needs c,o,e in scope
        wrapper = (
            "function __wrap(e){let c,o;\n"
            + snip + ";\n}\n"
        )
    elif kind == "outcome":
        # outcome is `let y=(()=>{...})()` -> needs n,e in scope
        wrapper = (
            "function __wrap(n,e){\n" + snip + ";\nreturn 0}\n"
        )
    else:
        raise ReapplyError("unknown snippet kind %r" % kind)

    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as tf:
        tf.write(wrapper)
        path = tf.name
    try:
        res = subprocess.run(["node", "--check", path],
                             capture_output=True, text=True)
        if res.returncode != 0:
            raise ReapplyError(
                "node --check FAILED for %s edit:\n%s" % (kind, res.stderr.strip())
            )
    finally:
        os.unlink(path)


# ----------------------------------- CLI -------------------------------------
def resolve_live_binary():
    link = os.path.expanduser("~/.local/bin/claude")
    real = os.path.realpath(link)
    if not os.path.exists(real):
        raise ReapplyError("resolved claude binary does not exist: %s" % real)
    return real


def detect_version(binary_path):
    try:
        # abspath so a relative path (e.g. "claude-all4") doesn't ENOENT -> false 127
        binary_path = os.path.abspath(binary_path)
        res = subprocess.run([binary_path, "--version"],
                             capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        # non-executable, missing interpreter, hang, etc. -> treat as launch failure
        return "", 127
    return res.stdout.strip(), res.returncode


SCRATCH = os.path.dirname(os.path.abspath(__file__))


def run(binary=None, out=None):
    """Do the full pipeline. Returns 0 on full success, 1 on a clean safe-degrade
    abort (after printing exactly what failed)."""
    try:
        binary = binary or resolve_live_binary()
        print("== binary ==")
        print("  path   :", binary)
        ver, rc = detect_version(binary)
        print("  version:", repr(ver), "rc", rc)
        if rc != 0 or not ver:
            raise ReapplyError("source binary --version failed (rc=%s)" % rc)
        short = ver.split()[0]

        print("\n== derive_constants ==")
        C = derive_constants(binary)
        for k in ("SECTION_FILEOFF", "DATA", "SECTION_SIZE_FIELD", "SEGMENT_FILESIZE",
                  "SEG_FILE_END", "blob_len", "sect_size", "trailer_abs", "data_end",
                  "offsets_abs", "padding", "cputype", "base"):
            v = C[k]
            print("  %-20s = %d (0x%X)" % (k, v, v))

        with open(binary, "rb") as f:
            data = f.read()

        print("\n== find edit sites ==")
        bar_off, bar_old, bar_names = find_bar_site(data)
        badge_off, badge_old, badge_names = find_badge_site(data)
        status_fn = find_status_fn(data)
        print("  BAR   off=%d (0x%X) names=%s" % (bar_off, bar_off, bar_names))
        print("        old: %s" % bar_old.decode("latin-1"))
        print("  BADGE off=%d (0x%X) names=%s" % (badge_off, badge_off, badge_names))
        print("        old: %s" % badge_old.decode("latin-1"))
        print("  STATUS helper captured: %r%s" % (
            status_fn, "" if status_fn else "  (will fall back to e.state)"))

        # Sanity: edits must not overlap.
        bar_end = bar_off + len(bar_old)
        badge_end = badge_off + len(badge_old)
        if not (badge_end <= bar_off or bar_end <= badge_off):
            raise ReapplyError("BAR and BADGE edit regions overlap; aborting")

        print("\n== build + syntax-check replacements ==")
        bar_new = build_bar_replacement(bar_names, status_fn)
        badge_new = build_badge_replacement(badge_names)
        syntax_check_js(bar_new, "bar")
        syntax_check_js(badge_new, "badge")
        print("  BAR   new (%+d): %s" % (len(bar_new) - len(bar_old), bar_new.decode("latin-1")))
        print("  BADGE new (%+d): %s" % (len(badge_new) - len(badge_old), badge_new.decode("latin-1")))
        print("  both node --check: OK")

        # Compose the BADGE old_bytes exactly: we only replace the `c=o` token,
        # i.e. group(5)=group(6) within the captured BADGE region. Build the
        # precise old/new for JUST `CVAR=MODELSRC`.
        cvar = badge_names["cvar"]; msrc = badge_names["modelsrc"]
        badge_token_old = (cvar + "=" + msrc).encode("latin-1")
        # locate that token's absolute offset WITHIN the matched badge region
        rel = badge_old.find(badge_token_old)
        if rel < 0:
            raise ReapplyError("could not locate `%s=%s` inside BADGE match" % (cvar, msrc))
        badge_token_off = badge_off + rel
        # build_badge_replacement already returns `CVAR=(()=>{...})()`
        badge_token_new = badge_new

        out = out or os.path.join(SCRATCH, "claude-%s-patched" % short)
        tmp_out = out + ".tmp"

        print("\n== apply edits to a COPY ==")
        # Apply BADGE first (don't sign yet), then BAR on the result (sign at end).
        # After each edit the downstream offsets shift; we re-find on the buffer.
        print("  [1/2] BADGE")
        info1 = patch(binary, tmp_out, badge_token_off, badge_token_old, badge_token_new, C, sign=False)
        for k in ("delta", "string_pointers_shifted", "string_pointers_grown",
                  "blob_len_new", "section_size_new", "padding_old", "padding_new"):
            print("        %-22s = %s" % (k, info1[k]))

        # Re-derive constants from the intermediate (blob/section sizes changed)
        # and re-find the BAR site (its offset shifted by the BADGE delta).
        C2 = derive_constants(tmp_out)
        with open(tmp_out, "rb") as f:
            data2 = f.read()
        bar_off2, bar_old2, bar_names2 = find_bar_site(data2)
        if bar_names2 != bar_names:
            raise ReapplyError("BAR names changed after BADGE edit (unexpected)")
        print("  [2/2] BAR (re-found at %d after BADGE shift)" % bar_off2)
        info2 = patch(tmp_out, tmp_out, bar_off2, bar_old2, bar_new, C2, sign=False)
        for k in ("delta", "string_pointers_shifted", "string_pointers_grown",
                  "blob_len_new", "section_size_new", "padding_old", "padding_new"):
            print("        %-22s = %s" % (k, info2[k]))

        total_delta = info1["delta"] + info2["delta"]

        # [3/4] ACTIVITY cap (re-derive + re-find after the prior shifts).
        C3 = derive_constants(tmp_out)
        with open(tmp_out, "rb") as f:
            data3 = f.read()
        try:
            act_off, act_old, act_new = find_activity_edit(data3)
            print("  [3/4] ACTIVITY cap %s -> %s" % (act_old.decode("latin-1"), act_new.decode("latin-1")))
            info3 = patch(tmp_out, tmp_out, act_off, act_old, act_new, C3, sign=False)
            total_delta += info3["delta"]
        except ReapplyError as e:
            print("  [3/4] ACTIVITY skipped (not found): %s" % e)

        # [4/4] OUTCOME json pretty-print (re-derive + re-find).
        C4 = derive_constants(tmp_out)
        with open(tmp_out, "rb") as f:
            data4 = f.read()
        try:
            out_off, out_old, out_new = find_outcome_edit(data4)
            syntax_check_js(out_new, "outcome")
            print("  [4/4] OUTCOME json viewer (glyph booleans) (%+d)" % (len(out_new) - len(out_old)))
            info4 = patch(tmp_out, tmp_out, out_off, out_old, out_new, C4, sign=False)
            total_delta += info4["delta"]
        except ReapplyError as e:
            print("  [4/4] OUTCOME skipped (not found): %s" % e)

        print("  total delta: %+d bytes" % total_delta)

        # CRITICAL (AMFI): patch() rewrote `tmp_out` in place several times, so its
        # inode has cached an "invalid signature" verdict from the intermediate
        # unsigned states — even a valid re-sign on that inode can still SIGKILL
        # (rc 137/127). Materialize the bytes into a FRESH inode for `out`, sign
        # THAT, and verify THAT. (Same gotcha as the live swap.)
        with open(tmp_out, "rb") as f:
            final_bytes = f.read()
        if os.path.exists(out):
            os.unlink(out)
        with open(out, "wb") as f:
            f.write(final_bytes)
        os.chmod(out, 0o755)
        subprocess.run(["codesign", "-f", "-s", "-", out], capture_output=True)
        try:
            os.unlink(tmp_out)
        except Exception:
            pass

        print("\n== verify patched COPY (fresh inode) ==")
        pver, prc = detect_version(out)
        print("  --version: %r rc %d" % (pver, prc))
        sig = subprocess.run(["codesign", "--verify", "--verbose=2", out],
                             capture_output=True, text=True)
        print("  codesign --verify rc: %d" % sig.returncode)
        if sig.stderr.strip():
            print("   ", sig.stderr.strip())

        bar_present   = (G_FULL.encode("latin-1") in final_bytes and
                         b'Math.floor(Date.now()/250)%10' in final_bytes)
        badge_present = b'(via Codex)' in final_bytes and b'"Codex "+' in final_bytes
        act_present   = b'_Lo=99,' in final_bytes or b'=99,' in final_bytes
        out_present   = b'__ln(JSON.parse(__t),0)' in final_bytes
        crash_present = b'codex exec returned ERROR' in final_bytes
        print("  bar:", bar_present, "| badge:", badge_present,
              "| activity:", act_present, "| outcome:", out_present,
              "| crash-detect:", crash_present)

        ok = (prc == 0 and pver == ver and sig.returncode == 0
              and bar_present and badge_present)
        if not ok:
            raise ReapplyError(
                "verification gate FAILED (rc=%d ver_match=%s sig=%d bar=%s badge=%s)"
                % (prc, pver == ver, sig.returncode, bar_present, badge_present)
            )
        print("\nRESULT: OK")
        print("  patched copy: %s" % out)
        return 0

    except ReapplyError as e:
        # clean safe-degrade: remove any partial tmp output, report what failed.
        try:
            if 'tmp_out' in locals() and os.path.exists(tmp_out):
                os.unlink(tmp_out)
        except Exception:
            pass
        print("\nABORT (safe-degrade): %s" % e, file=sys.stderr)
        print("RESULT: FAILED", file=sys.stderr)
        return 1


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(description="Version-agnostic Bun reapply tool (BAR + BADGE)")
    ap.add_argument("--binary", default=None,
                    help="path to claude binary (default: resolve ~/.local/bin/claude)")
    ap.add_argument("--out", default=None,
                    help="output patched copy (default: scratchpad/claude-<ver>-patched)")
    args = ap.parse_args(argv)
    return run(binary=args.binary, out=args.out)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
