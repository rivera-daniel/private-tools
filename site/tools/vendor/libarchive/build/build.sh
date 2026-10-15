#!/usr/bin/env bash
# Rebuilds libarchive.js and libarchive.wasm from pinned upstream sources with Emscripten.
# Requires emcc on PATH (Emscripten SDK), curl, tar, make and a C toolchain for configure checks.
# Usage: site/tools/vendor/libarchive/build/build.sh [work directory]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(dirname "$HERE")"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK/src" "$WORK/prefix"
PREFIX="$WORK/prefix"
JOBS="$(nproc 2>/dev/null || echo 4)"

# name|url|sha256
SOURCES=(
  "libarchive-3.8.10.tar.xz|https://www.libarchive.org/downloads/libarchive-3.8.10.tar.xz|56cad765459d5ee25a3b761f90c47d99379d28297fbfb72d908880d6b875fb96"
  "zlib-1.3.2.tar.gz|https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz|bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16"
  "xz-5.8.4.tar.gz|https://github.com/tukaani-project/xz/releases/download/v5.8.4/xz-5.8.4.tar.gz|0014c7886930454fe8bd4228665b51af55eeae560ea135c9c4cd33f55b2591d9"
  "bzip2-1.0.8.tar.gz|https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz|ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269"
  "zstd-1.5.7.tar.gz|https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz|eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3"
  "lz4-1.10.0.tar.gz|https://github.com/lz4/lz4/releases/download/v1.10.0/lz4-1.10.0.tar.gz|537512904744b35e232912055ccf8ec66d768639ff3abe5788d90d792ec5f48b"
)

cd "$WORK/src"
for entry in "${SOURCES[@]}"; do
  IFS='|' read -r name url sum <<<"$entry"
  [ -f "$name" ] || curl -fsSL -o "$name" "$url"
  echo "$sum  $name" | sha256sum -c --quiet -
  rm -rf "${name%.tar.*}"; tar xf "$name"
done

export CFLAGS="-O2 -fno-exceptions"
export CPPFLAGS="-I$PREFIX/include"
export LDFLAGS="-L$PREFIX/lib"

(cd zlib-1.3.2 && emconfigure ./configure --static --prefix="$PREFIX" >/dev/null && emmake make -j"$JOBS" install >/dev/null)

(cd bzip2-1.0.8 && for f in blocksort huffman crctable randtable compress decompress bzlib; do emcc $CFLAGS -D_FILE_OFFSET_BITS=64 -c "$f.c"; done \
  && emar rcs "$PREFIX/lib/libbz2.a" blocksort.o huffman.o crctable.o randtable.o compress.o decompress.o bzlib.o && cp bzlib.h "$PREFIX/include/")

(cd xz-5.8.4 && emconfigure ./configure --prefix="$PREFIX" --host=wasm32-unknown-emscripten --disable-shared --enable-static --disable-threads \
  --disable-xz --disable-xzdec --disable-lzmadec --disable-lzmainfo --disable-lzma-links --disable-scripts --disable-doc --disable-nls >/dev/null \
  && emmake make -j"$JOBS" -C src/liblzma install >/dev/null)

(cd zstd-1.5.7/lib && emmake make -j"$JOBS" libzstd.a ZSTD_LEGACY_SUPPORT=0 >/dev/null && cp libzstd.a "$PREFIX/lib/" && cp zstd.h zstd_errors.h zdict.h "$PREFIX/include/")

(cd lz4-1.10.0/lib && emmake make -j"$JOBS" liblz4.a >/dev/null && cp liblz4.a "$PREFIX/lib/" && cp lz4.h lz4hc.h lz4frame.h "$PREFIX/include/")

# libarchive cannot decrypt 7z archives. 7zip-aes.patch adds AES-256 decryption (sevenzip_aes.c).
(cd libarchive-3.8.10 && patch -p1 --quiet < "$HERE/7zip-aes.patch")

(cd libarchive-3.8.10 && emconfigure ./configure --prefix="$PREFIX" --host=wasm32-unknown-emscripten --disable-shared --enable-static \
  --disable-bsdtar --disable-bsdcat --disable-bsdcpio --disable-bsdunzip --disable-acl --disable-xattr \
  --with-zlib --with-bz2lib --with-lzma --with-zstd --with-lz4 --without-libb2 --without-iconv \
  --without-openssl --without-nettle --without-mbedtls --without-cng --without-xml2 --without-expat --without-lzo2 >/dev/null \
  && emmake make -j"$JOBS" libarchive.la >/dev/null && cp .libs/libarchive.a "$PREFIX/lib/" && cp libarchive/archive.h libarchive/archive_entry.h "$PREFIX/include/")

EXPORTS="_malloc,_free,_ar_open,_ar_last_error,_ar_error,_ar_next,_ar_path,_ar_size,_ar_type,_ar_mtime,_ar_encrypted,_ar_hardlink,_ar_data,_ar_skip,_ar_format,_ar_filters,_ar_filter,_ar_has_encrypted,_ar_close,_ar_version,_aw_open,_aw_header,_aw_data,_aw_close,_aw_free"

emcc -O2 "$HERE/glue.c" "$HERE/sevenzip_aes.c" -I"$PREFIX/include" \
  "$PREFIX/lib/libarchive.a" "$PREFIX/lib/liblzma.a" "$PREFIX/lib/libzstd.a" "$PREFIX/lib/liblz4.a" "$PREFIX/lib/libbz2.a" "$PREFIX/lib/libz.a" \
  -o "$OUT/libarchive.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLibarchive -sENVIRONMENT=worker \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=1MB \
  -sDYNAMIC_EXECUTION=0 -sFILESYSTEM=1 -sTEXTDECODER=2 \
  -sEXPORTED_FUNCTIONS="$EXPORTS" -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,stringToNewUTF8

# NOTICE: what the binaries contain, where each part came from, and every license that applies.
EMVER="$(emcc --version | head -1 | sed 's/.*) //; s/ (.*//')"
EMROOT="$(dirname "$(command -v emcc)")"
{
  cat <<NOTICE
libarchive.js and libarchive.wasm: libarchive compiled to WebAssembly for the Archiver
=====================================================================================

These two files are built by build/build.sh from the upstream sources below, with Emscripten $EMVER.
build/glue.c connects libarchive to the page, build/sevenzip_aes.c and build/7zip-aes.patch add 7-Zip
AES-256 decryption to libarchive's 7z reader. Those three files are part of Private Tools and are
licensed under the GNU Affero General Public License version 3 like the rest of this repository.

The files load nothing except libarchive.wasm from this directory and make no other network requests.
No OpenSSL and no unRAR code is included: libarchive's RAR readers are its own BSD-licensed code, and
cryptography is limited to the 7-Zip AES code in sevenzip_aes.c.

Component        Version   License                                  Source archive (sha256)
NOTICE
  for entry in "${SOURCES[@]}"; do
    IFS='|' read -r name url sum <<<"$entry"
    case "$name" in
      libarchive*) lic="BSD-2-Clause (some parts: see below)" ;;
      zlib*) lic="Zlib" ;;
      xz*) lic="0BSD (liblzma)" ;;
      bzip2*) lic="bzip2-1.0.6 (BSD-style)" ;;
      zstd*) lic="BSD-3-Clause (dual BSD/GPLv2, BSD chosen)" ;;
      lz4*) lic="BSD-2-Clause (lib)" ;;
    esac
    ver="${name%.tar.*}"
    printf '%-16s %-9s %-40s %s\n                                                                    %s\n' "${ver%-*}" "${ver##*-}" "$lic" "$url" "$sum"
  done
  printf '%-16s %-9s %s\n' "Emscripten" "$EMVER" "MIT or NCSA (runtime, libc from musl: MIT, malloc: public domain)"
  echo
  echo "Built files (sha256):"
  ( cd "$OUT" && sha256sum libarchive.js libarchive.wasm )
  echo
  echo "All of these licenses are permissive and compatible with the GNU AGPL version 3."
  section() { printf '\n\n==== %s ====\n\n' "$1"; }
  section "libarchive (COPYING)"; cat "$WORK/src/libarchive-3.8.10/COPYING"
  section "libarchive: archive_read_support_filter_compress.c (University of California)"; sed -n '/Regents of the University of California/,/SUCH DAMAGE/p' "$WORK/src/libarchive-3.8.10/libarchive/archive_read_support_filter_compress.c" | sed 's/^ \* \{0,1\}//'
  section "zlib"; cat "$WORK/src/zlib-1.3.2/LICENSE"
  section "XZ Utils / liblzma (0BSD)"; cat "$WORK/src/xz-5.8.4/COPYING.0BSD"
  section "bzip2"; cat "$WORK/src/bzip2-1.0.8/LICENSE"
  section "Zstandard"; cat "$WORK/src/zstd-1.5.7/LICENSE"
  section "LZ4 library"; cat "$WORK/src/lz4-1.10.0/lib/LICENSE"
  section "Emscripten"; cat "$EMROOT/LICENSE"
  section "musl libc (part of the Emscripten runtime)"; cat "$EMROOT/system/lib/libc/musl/COPYRIGHT"
} > "$OUT/NOTICE"

( cd "$OUT" && sha256sum libarchive.js libarchive.wasm )
echo "Built in $WORK"
