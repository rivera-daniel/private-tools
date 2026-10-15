/* 7-Zip AES-256 decryption (codec 06F10701) for libarchive's 7z reader, added by 7zip-aes.patch.
 * Key: SHA-256 over 2^NumCyclesPower rounds of salt, the UTF-16LE password and a 64-bit round counter.
 * Data: AES-256 in CBC mode. Written from the 7z format documentation and FIPS 180-4 and FIPS 197. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct { uint32_t h[8]; uint8_t buf[64]; size_t fill; uint64_t total; } sha256;

static const uint32_t K[64] = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2 };

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha256_block(sha256 *s, const uint8_t *p) {
  uint32_t w[64], a, b, c, d, e, f, g, h;
  for (int i = 0; i < 16; i++) w[i] = (uint32_t)p[4*i] << 24 | (uint32_t)p[4*i+1] << 16 | (uint32_t)p[4*i+2] << 8 | p[4*i+3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = ROR(w[i-15], 7) ^ ROR(w[i-15], 18) ^ (w[i-15] >> 3), s1 = ROR(w[i-2], 17) ^ ROR(w[i-2], 19) ^ (w[i-2] >> 10);
    w[i] = w[i-16] + s0 + w[i-7] + s1;
  }
  a = s->h[0]; b = s->h[1]; c = s->h[2]; d = s->h[3]; e = s->h[4]; f = s->h[5]; g = s->h[6]; h = s->h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t t1 = h + (ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
    uint32_t t2 = (ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
    h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  s->h[0] += a; s->h[1] += b; s->h[2] += c; s->h[3] += d; s->h[4] += e; s->h[5] += f; s->h[6] += g; s->h[7] += h;
}

static void sha256_init(sha256 *s) {
  static const uint32_t iv[8] = { 0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19 };
  memcpy(s->h, iv, sizeof iv); s->fill = 0; s->total = 0;
}

static void sha256_update(sha256 *s, const uint8_t *p, size_t n) {
  s->total += n;
  while (n) {
    size_t take = 64 - s->fill; if (take > n) take = n;
    memcpy(s->buf + s->fill, p, take); s->fill += take; p += take; n -= take;
    if (s->fill == 64) { sha256_block(s, s->buf); s->fill = 0; }
  }
}

static void sha256_final(sha256 *s, uint8_t out[32]) {
  uint64_t bits = s->total * 8; uint8_t pad = 0x80, zero = 0, len[8];
  sha256_update(s, &pad, 1);
  while (s->fill != 56) sha256_update(s, &zero, 1);
  for (int i = 0; i < 8; i++) len[i] = (uint8_t)(bits >> (56 - 8 * i));
  sha256_update(s, len, 8);
  for (int i = 0; i < 8; i++) { out[4*i] = s->h[i] >> 24; out[4*i+1] = s->h[i] >> 16; out[4*i+2] = s->h[i] >> 8; out[4*i+3] = s->h[i]; }
}

/* AES-256 decryption (FIPS 197, inverse cipher). */
static uint8_t SB[256], ISB[256];
static int tables_ready;
static uint8_t xt(uint8_t x) { return (uint8_t)((x << 1) ^ ((x & 0x80) ? 0x1b : 0)); }
static uint8_t mul(uint8_t a, uint8_t b) { uint8_t r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; }
static void tables(void) {
  uint8_t p = 1, q = 1;
  do {
    p = p ^ (uint8_t)(p << 1) ^ ((p & 0x80) ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; if (q & 0x80) q ^= 0x09;
    uint8_t x = q ^ (uint8_t)((q << 1) | (q >> 7)) ^ (uint8_t)((q << 2) | (q >> 6)) ^ (uint8_t)((q << 3) | (q >> 5)) ^ (uint8_t)((q << 4) | (q >> 4));
    SB[p] = x ^ 0x63;
  } while (p != 1);
  SB[0] = 0x63;
  for (int i = 0; i < 256; i++) ISB[SB[i]] = (uint8_t)i;
  tables_ready = 1;
}

typedef struct { uint8_t rk[240]; uint8_t iv[16]; } sevenzip_aes;

static void expand(sevenzip_aes *c, const uint8_t key[32]) {
  uint8_t *w = c->rk, rcon = 1;
  memcpy(w, key, 32);
  for (int i = 8; i < 60; i++) {
    uint8_t t[4]; memcpy(t, w + 4 * (i - 1), 4);
    if (i % 8 == 0) { uint8_t u = t[0]; t[0] = SB[t[1]] ^ rcon; t[1] = SB[t[2]]; t[2] = SB[t[3]]; t[3] = SB[u]; rcon = xt(rcon); }
    else if (i % 8 == 4) for (int j = 0; j < 4; j++) t[j] = SB[t[j]];
    for (int j = 0; j < 4; j++) w[4 * i + j] = w[4 * (i - 8) + j] ^ t[j];
  }
}

static void decrypt_block(const sevenzip_aes *c, uint8_t s[16]) {
  const uint8_t *rk = c->rk;
  for (int i = 0; i < 16; i++) s[i] ^= rk[224 + i];
  for (int round = 13; round >= 0; round--) {
    uint8_t t[16];
    for (int i = 0; i < 16; i++) t[i] = s[(i + 4 * (i % 4) * 3) % 16]; /* inverse ShiftRows */
    for (int i = 0; i < 16; i++) s[i] = ISB[t[i]] ^ rk[16 * round + i];
    if (round == 0) break;
    for (int col = 0; col < 4; col++) {
      uint8_t *m = s + 4 * col, a0 = m[0], a1 = m[1], a2 = m[2], a3 = m[3];
      m[0] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
      m[1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
      m[2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
      m[3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
    }
  }
}

/* Returns a context for the coder properties and UTF-8 password, or NULL when the properties are invalid
 * or ask for more than 2^24 key derivation rounds (7-Zip's own limit). */
void *sevenzip_aes_new(const unsigned char *props, size_t size, const char *password) {
  if (!tables_ready) tables();
  if (size < 1) return NULL;
  unsigned power = props[0] & 0x3f, salt_size = 0, iv_size = 0;
  if (props[0] & 0xc0) {
    if (size < 2) return NULL;
    salt_size = ((props[0] >> 7) & 1) + (props[1] >> 4);
    iv_size = ((props[0] >> 6) & 1) + (props[1] & 0x0f);
    if (size != 2 + salt_size + iv_size) return NULL;
  } else if (size != 1) return NULL;
  if (power > 24 && power != 0x3f) return NULL;
  const unsigned char *salt = props + 2, *iv = props + 2 + salt_size;

  /* UTF-8 to UTF-16LE. */
  size_t n = strlen(password), u = 0;
  unsigned char *pw = malloc(4 * n + 2);
  if (!pw) return NULL;
  for (size_t i = 0; i < n;) {
    uint32_t cp; unsigned char b = (unsigned char)password[i];
    int len = b < 0x80 ? 1 : (b >> 5) == 6 ? 2 : (b >> 4) == 14 ? 3 : (b >> 3) == 30 ? 4 : 1;
    cp = len == 1 ? b : len == 2 ? b & 0x1f : len == 3 ? b & 0x0f : b & 0x07;
    for (int k = 1; k < len && i + k < n; k++) cp = (cp << 6) | ((unsigned char)password[i + k] & 0x3f);
    i += len;
    if (cp >= 0x10000) { cp -= 0x10000; uint32_t hi = 0xd800 | (cp >> 10), lo = 0xdc00 | (cp & 0x3ff); pw[u++] = hi; pw[u++] = hi >> 8; pw[u++] = lo; pw[u++] = lo >> 8; }
    else { pw[u++] = cp; pw[u++] = cp >> 8; }
  }

  uint8_t key[32];
  if (power == 0x3f) {
    memset(key, 0, 32);
    size_t k = 0;
    for (size_t i = 0; i < salt_size && k < 32; i++) key[k++] = salt[i];
    for (size_t i = 0; i < u && k < 32; i++) key[k++] = pw[i];
  } else {
    sha256 s; sha256_init(&s);
    uint8_t counter[8] = {0};
    for (uint64_t round = 0; round < ((uint64_t)1 << power); round++) {
      sha256_update(&s, salt, salt_size); sha256_update(&s, pw, u); sha256_update(&s, counter, 8);
      for (int i = 0; i < 8 && ++counter[i] == 0; i++) {}
    }
    sha256_final(&s, key);
  }
  free(pw);
  sevenzip_aes *c = calloc(1, sizeof *c);
  if (!c) return NULL;
  expand(c, key);
  memcpy(c->iv, iv, iv_size);
  memset(key, 0, sizeof key);
  return c;
}

/* Decrypts length bytes (a multiple of 16) in place, continuing the CBC chain. */
void sevenzip_aes_decrypt(void *ctx, unsigned char *data, size_t length) {
  sevenzip_aes *c = ctx;
  for (size_t o = 0; o + 16 <= length; o += 16) {
    uint8_t block[16]; memcpy(block, data + o, 16);
    decrypt_block(c, data + o);
    for (int i = 0; i < 16; i++) data[o + i] ^= c->iv[i];
    memcpy(c->iv, block, 16);
  }
}

void sevenzip_aes_free(void *ctx) { if (ctx) { memset(ctx, 0, sizeof(sevenzip_aes)); free(ctx); } }
