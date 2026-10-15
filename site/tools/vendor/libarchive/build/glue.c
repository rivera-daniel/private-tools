/* Bridge between libarchive and the Archiver worker. Archives are read through callbacks that pull byte
 * ranges from the File on demand, so an archive is never copied into WebAssembly memory as a whole. Seeking
 * is supported, which 7z, ZIP, ISO and CAB need. Output of the 7z writer is handed to JavaScript in chunks. */
#include <archive.h>
#include <archive_entry.h>
#include <emscripten.h>
#include <errno.h>
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

EM_JS(int, js_read, (double offset, int length, void *dst), { return Module.readAt(offset, length, dst); });
EM_JS(int, js_write, (const void *src, int length), { return Module.writeOut(src, length); });

#define BUFFER (1 << 20)

typedef struct { double size, pos; unsigned char *buf; } source;

static char error_text[512];
static struct archive_entry *current;

static la_ssize_t on_read(struct archive *a, void *data, const void **out) {
  source *s = data;
  double left = s->size - s->pos;
  int want = left < BUFFER ? (int)left : BUFFER;
  *out = s->buf;
  if (want <= 0) return 0;
  int n = js_read(s->pos, want, s->buf);
  if (n < 0) { archive_set_error(a, EIO, "The file could not be read."); return -1; }
  s->pos += n;
  return n;
}

static la_int64_t on_skip(struct archive *a, void *data, la_int64_t request) {
  source *s = data;
  (void)a;
  double left = s->size - s->pos;
  if ((double)request > left) request = (la_int64_t)left;
  if (request < 0) request = 0;
  s->pos += (double)request;
  return request;
}

static la_int64_t on_seek(struct archive *a, void *data, la_int64_t offset, int whence) {
  source *s = data;
  (void)a;
  double p = whence == SEEK_SET ? (double)offset : whence == SEEK_CUR ? s->pos + (double)offset : s->size + (double)offset;
  if (p < 0) return ARCHIVE_FATAL;
  if (p > s->size) p = s->size;
  s->pos = p;
  return (la_int64_t)p;
}

static int on_close(struct archive *a, void *data) {
  source *s = data;
  (void)a;
  free(s->buf);
  free(s);
  return ARCHIVE_OK;
}

/* Opens an archive of `size` bytes. raw adds libarchive's raw format, for single compressed files such as
 * .xz or .bz2 that hold no archive. Returns NULL on failure; ar_last_error() then describes why. */
EMSCRIPTEN_KEEPALIVE struct archive *ar_open(double size, const char *passphrase, int raw) {
  setlocale(LC_ALL, "C.UTF-8");
  struct archive *a = archive_read_new();
  archive_read_support_filter_all(a);
  archive_read_support_format_all(a);
  if (raw) archive_read_support_format_raw(a);
  if (passphrase && *passphrase) archive_read_add_passphrase(a, passphrase);
  source *s = calloc(1, sizeof *s);
  s->size = size;
  s->buf = malloc(BUFFER);
  archive_read_set_read_callback(a, on_read);
  archive_read_set_skip_callback(a, on_skip);
  archive_read_set_seek_callback(a, on_seek);
  archive_read_set_close_callback(a, on_close);
  archive_read_set_callback_data(a, s);
  if (archive_read_open1(a) != ARCHIVE_OK) {
    snprintf(error_text, sizeof error_text, "%s", archive_error_string(a) ? archive_error_string(a) : "unrecognized archive");
    archive_read_free(a);
    return NULL;
  }
  return a;
}

EMSCRIPTEN_KEEPALIVE const char *ar_last_error(void) { return error_text; }
EMSCRIPTEN_KEEPALIVE const char *ar_error(struct archive *a) { const char *e = archive_error_string(a); return e ? e : ""; }
EMSCRIPTEN_KEEPALIVE int ar_next(struct archive *a) { return archive_read_next_header(a, &current); }
EMSCRIPTEN_KEEPALIVE const char *ar_path(void) {
  const char *p = archive_entry_pathname_utf8(current);
  if (!p) p = archive_entry_pathname(current);
  return p ? p : "";
}
EMSCRIPTEN_KEEPALIVE double ar_size(void) { return archive_entry_size_is_set(current) ? (double)archive_entry_size(current) : -1; }
EMSCRIPTEN_KEEPALIVE int ar_type(void) { return (int)archive_entry_filetype(current); }
EMSCRIPTEN_KEEPALIVE double ar_mtime(void) { return archive_entry_mtime_is_set(current) ? (double)archive_entry_mtime(current) : -1; }
EMSCRIPTEN_KEEPALIVE int ar_encrypted(void) { return archive_entry_is_encrypted(current); }
EMSCRIPTEN_KEEPALIVE int ar_hardlink(void) { return archive_entry_hardlink(current) != NULL; }
EMSCRIPTEN_KEEPALIVE int ar_data(struct archive *a, void *buf, int length) { return (int)archive_read_data(a, buf, (size_t)length); }
EMSCRIPTEN_KEEPALIVE int ar_skip(struct archive *a) { return archive_read_data_skip(a); }
EMSCRIPTEN_KEEPALIVE const char *ar_format(struct archive *a) { const char *f = archive_format_name(a); return f ? f : ""; }
EMSCRIPTEN_KEEPALIVE int ar_filters(struct archive *a) { return archive_filter_count(a); }
EMSCRIPTEN_KEEPALIVE const char *ar_filter(struct archive *a, int i) { const char *f = archive_filter_name(a, i); return f ? f : ""; }
EMSCRIPTEN_KEEPALIVE int ar_has_encrypted(struct archive *a) { return archive_read_has_encrypted_entries(a); }
EMSCRIPTEN_KEEPALIVE void ar_close(struct archive *a) { archive_read_free(a); }
EMSCRIPTEN_KEEPALIVE const char *ar_version(void) { return archive_version_details(); }

static la_ssize_t on_write(struct archive *a, void *data, const void *buf, size_t length) {
  (void)data;
  if (js_write(buf, (int)length) < 0) { archive_set_error(a, EIO, "The output could not be written."); return -1; }
  return (la_ssize_t)length;
}

/* Starts a 7z archive. compression: "lzma2", "lzma1", "deflate", "bzip2", "ppmd" or "store". */
EMSCRIPTEN_KEEPALIVE struct archive *aw_open(const char *compression, int level) {
  setlocale(LC_ALL, "C.UTF-8");
  struct archive *a = archive_write_new();
  char value[4];
  archive_write_set_format_7zip(a);
  archive_write_set_bytes_in_last_block(a, 1);
  if (archive_write_set_format_option(a, "7zip", "compression", compression) != ARCHIVE_OK) goto fail;
  snprintf(value, sizeof value, "%d", level);
  if (strcmp(compression, "store") != 0 && archive_write_set_format_option(a, "7zip", "compression-level", value) != ARCHIVE_OK) goto fail;
  if (archive_write_open2(a, NULL, NULL, on_write, NULL, NULL) != ARCHIVE_OK) goto fail;
  return a;
fail:
  snprintf(error_text, sizeof error_text, "%s", archive_error_string(a) ? archive_error_string(a) : "could not start the archive");
  archive_write_free(a);
  return NULL;
}

/* Adds an entry header. mtime < 0 leaves the date out. Directories get no data. */
EMSCRIPTEN_KEEPALIVE int aw_header(struct archive *a, const char *path, double size, double mtime, int directory) {
  struct archive_entry *e = archive_entry_new();
  archive_entry_set_pathname_utf8(e, path);
  archive_entry_set_filetype(e, directory ? AE_IFDIR : AE_IFREG);
  archive_entry_set_perm(e, directory ? 0755 : 0644);
  archive_entry_set_size(e, directory ? 0 : (la_int64_t)size);
  if (mtime >= 0) archive_entry_set_mtime(e, (time_t)mtime, 0);
  int r = archive_write_header(a, e);
  archive_entry_free(e);
  return r;
}

EMSCRIPTEN_KEEPALIVE int aw_data(struct archive *a, const void *buf, int length) { return (int)archive_write_data(a, buf, (size_t)length); }
EMSCRIPTEN_KEEPALIVE int aw_close(struct archive *a) { int r = archive_write_close(a); if (r != ARCHIVE_OK) snprintf(error_text, sizeof error_text, "%s", archive_error_string(a) ? archive_error_string(a) : "could not finish the archive"); archive_write_free(a); return r; }
EMSCRIPTEN_KEEPALIVE void aw_free(struct archive *a) { archive_write_free(a); }
