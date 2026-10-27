/*
 * TypeSOL runtime support for generated programs.
 *
 * Every generated program includes this header. It holds the error codes, the
 * account checks the compiler emits by default, and thin wrappers over the
 * System / SPL Token CPIs and sysvars the language exposes.
 */
#pragma once
#include <solana_sdk.h>

/*
 * ---- Error codes (returned as Custom(n)) --------------------------------
 * Where Anchor has a framework error with the same meaning, TypeSOL uses Anchor's number, so Anchor and
 * Codama clients name failures correctly. TypeSOL-only conditions live in 5100-5199, which Anchor leaves
 * unused. User errors start at 6000 as in Anchor.
 */
#define TS_ERR_INSTRUCTION_MISSING 100     /* InstructionMissing */
#define TS_ERR_INSTRUCTION_NOT_FOUND 101   /* InstructionFallbackNotFound */
#define TS_ERR_INSTRUCTION_DATA 102        /* InstructionDidNotDeserialize */
#define TS_ERR_NOT_WRITABLE 3006           /* AccountNotMutable */
#define TS_ERR_CONSTRAINT 2001             /* ConstraintHasOne */
#define TS_ERR_NOT_RENT_EXEMPT 2005        /* ConstraintRentExempt */
#define TS_ERR_CONSTRAINT_SIGNER 2002      /* ConstraintSigner */
#define TS_ERR_CONSTRAINT_OWNER 2004       /* ConstraintOwner */
#define TS_ERR_SEEDS 2006                  /* ConstraintSeeds */
#define TS_ERR_CONSTRAINT_EXECUTABLE 2007  /* ConstraintExecutable */
#define TS_ERR_ASSOCIATED 2009             /* ConstraintAssociated */
#define TS_ERR_ADDRESS 2012                /* ConstraintAddress */
#define TS_ERR_TOKEN_MINT 2014             /* ConstraintTokenMint */
#define TS_ERR_TOKEN_OWNER 2015            /* ConstraintTokenOwner */
#define TS_ERR_MINT_AUTHORITY 2016         /* ConstraintMintMintAuthority */
#define TS_ERR_FREEZE_AUTHORITY 2017       /* ConstraintMintFreezeAuthority */
#define TS_ERR_DUPLICATE_MUT 2040          /* ConstraintDuplicateMutableAccount */
#define TS_ERR_ALREADY_INITIALIZED 3000    /* AccountDiscriminatorAlreadySet */
#define TS_ERR_DISCRIMINATOR 3002          /* AccountDiscriminatorMismatch */
#define TS_ERR_ACCOUNT_TOO_SMALL 3003      /* AccountDidNotDeserialize */
#define TS_ERR_TOKEN_ACCOUNT 3003          /* AccountDidNotDeserialize (not an initialized token account) */
#define TS_ERR_MINT 3003                   /* AccountDidNotDeserialize (not an initialized mint) */
#define TS_ERR_NOT_ENOUGH_ACCOUNTS 3005    /* AccountNotEnoughKeys */
#define TS_ERR_WRONG_OWNER 3007            /* AccountOwnedByWrongProgram */
#define TS_ERR_WRONG_PROGRAM 3008          /* InvalidProgramId */
#define TS_ERR_NOT_EXECUTABLE 3009         /* InvalidProgramExecutable */
#define TS_ERR_NOT_SIGNER 3010             /* AccountNotSigner */
#define TS_ERR_NOT_INITIALIZED 3012        /* AccountNotInitialized */
#define TS_ERR_REALLOC 3016                /* AccountReallocExceedsLimit */
#define TS_ERR_CAST 4102                   /* InvalidNumericConversion */
#define TS_ERR_OVERFLOW 5100
#define TS_ERR_DIV_ZERO 5101
#define TS_ERR_SYSVAR 5103
#define TS_ERR_INDEX 5104
#define TS_ERR_STRING_TOO_LONG 5105
#define TS_ERR_RETURN_DATA 5106
#define TS_ERR_EVENT_TOO_LARGE 5107
#define TS_ERR_UNWRAP 5108
#define TS_ERR_HEAP 5110
#define TS_ERR_ORACLE 5111
#define TS_ERR_ENUM_VARIANT 5112
#define TS_ERR_TOO_MANY_ACCOUNTS 5113
#define TS_ERR_NO_RETURN 5114
#define TS_ERR_ACCOUNT_MISSING 5115

#define TS_FAIL(code, msg) \
  do {                     \
    sol_log(msg);          \
    return (code);         \
  } while (0)

#define TS_TRY(expr)                 \
  do {                               \
    uint64_t ts_r_ = (expr);         \
    if (ts_r_ != SUCCESS) return ts_r_; \
  } while (0)

/*
 * ---- Word-wise memory helpers --------------------------------------------
 * The SDK's sol_memcmp / sol_memcpy / sol_memset and SolPubkey_same walk one byte per iteration (about 11
 * instructions, so 11 CU, per byte). SBF loads and stores may be unaligned, so these move 8 bytes per instruction
 * through a 1-byte-aligned type (clang then emits plain ldxdw/stxdw even where it cannot prove alignment, e.g. the
 * program id, which follows the variable-length instruction data). Constant sizes unroll completely.
 */
typedef uint64_t __attribute__((aligned(1), may_alias)) ts_u64_unaligned;
static inline __attribute__((always_inline)) uint64_t ts_ld64(const void *p) { return *(const ts_u64_unaligned *)p; }
static inline __attribute__((always_inline)) void ts_st64(void *p, uint64_t v) { *(ts_u64_unaligned *)p = v; }
typedef uint32_t __attribute__((aligned(1), may_alias)) ts_u32_unaligned;

/* Byte-for-byte equality (only equality: lexicographic order is ts_bytes_cmp). */
static inline __attribute__((always_inline)) bool ts_mem_eq(const void *a, const void *b, uint64_t n) {
  const uint8_t *x = (const uint8_t *)a, *y = (const uint8_t *)b;
  for (; n >= 8; n -= 8, x += 8, y += 8)
    if (ts_ld64(x) != ts_ld64(y)) return false;
  for (; n; n--, x++, y++)
    if (*x != *y) return false;
  return true;
}

/* Forward copy of non-overlapping bytes (every caller copies between distinct places or onto itself). */
static inline __attribute__((always_inline)) void ts_memcpy(void *dst, const void *src, uint64_t n) {
  uint8_t *d = (uint8_t *)dst;
  const uint8_t *s = (const uint8_t *)src;
  for (; n >= 8; n -= 8, d += 8, s += 8) ts_st64(d, ts_ld64(s));
  for (; n; n--) *d++ = *s++;
}

static inline __attribute__((always_inline)) void ts_memzero(void *dst, uint64_t n) {
  uint8_t *d = (uint8_t *)dst;
  for (; n >= 8; n -= 8, d += 8) ts_st64(d, 0);
  for (; n; n--) *d++ = 0;
}

/*
 * Checked u64 addition and subtraction. Same results as __builtin_add/sub_overflow, but written as one compare
 * on the operands, which clang lowers to a single branch on SBF instead of materializing the carry flag.
 */
static inline __attribute__((always_inline)) bool ts_add_overflow_u64(uint64_t a, uint64_t b, uint64_t *out) {
  *out = a + b;
  return b > ~a;
}
static inline __attribute__((always_inline)) bool ts_sub_overflow_u64(uint64_t a, uint64_t b, uint64_t *out) {
  *out = a - b;
  return b > a;
}

/*
 * Checked u64 multiplication. __builtin_mul_overflow widens to 128 bits and calls __multi3 on SBF (tens of CU;
 * clang also rewrites a division-based test back into that call). When both factors fit in 32 bits the product
 * cannot overflow, so only larger factors pay for the full check.
 */
static inline __attribute__((always_inline)) bool ts_mul_overflow_u64(uint64_t a, uint64_t b, uint64_t *out) {
  if (((a | b) >> 32) == 0) {
    *out = a * b;
    return false;
  }
  return __builtin_mul_overflow(a, b, out);
}

/* ---- Well-known program ids --------------------------------------------- */
static const SolPubkey TS_SYSTEM_PROGRAM_ID = {{0}};
/* TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA */
static const SolPubkey TS_TOKEN_PROGRAM_ID = {{
    6,   221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70,  206, 235, 121, 172,
    28,  180, 133, 237, 95,  91,  55,  145, 58,  140, 245, 133, 126, 255, 0,   169,
}};

/* TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb */
static const SolPubkey TS_TOKEN_2022_PROGRAM_ID = {{
    6,   221, 246, 225, 238, 117, 143, 222, 24,  66,  93,  188, 228, 108, 205, 218,
    182, 26,  252, 77,  131, 185, 13,  39,  254, 189, 249, 40,  216, 161, 139, 252,
}};

/* ---- Strings ------------------------------------------------------------- */
/* A read-only view: string literals, instruction arguments, FixedString contents. */
typedef struct {
  const uint8_t *ptr;
  uint64_t len;
} TS_Str;

static inline TS_Str ts_str(const uint8_t *ptr, uint64_t len) {
  TS_Str s = {ptr, len};
  return s;
}
/* Well-formed UTF-8 (no overlong forms, surrogates or code points past U+10FFFF), as Borsh `String` requires. */
static inline bool ts_utf8_valid(const uint8_t *p, uint64_t n) {
  uint64_t i = 0;
  while (i < n) {
    uint8_t c = p[i];
    if (c < 0x80) { i++; continue; }
    uint64_t len;
    uint32_t cp;
    if (c >= 0xc2 && c <= 0xdf) { len = 2; cp = c & 0x1f; }
    else if (c >= 0xe0 && c <= 0xef) { len = 3; cp = c & 0x0f; }
    else if (c >= 0xf0 && c <= 0xf4) { len = 4; cp = c & 0x07; }
    else return false;
    if (i + len > n) return false;
    for (uint64_t k = 1; k < len; k++) {
      if ((p[i + k] & 0xc0) != 0x80) return false;
      cp = (cp << 6) | (p[i + k] & 0x3f);
    }
    if ((len == 3 && cp < 0x800) || (len == 4 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += len;
  }
  return true;
}

/* Every byte zero (an empty Option's value must be zeroed, as the IDL documents). */
static inline bool ts_is_zero(const void *p, uint64_t n) {
  const uint8_t *b = (const uint8_t *)p;
  for (uint64_t i = 0; i < n; i++) if (b[i]) return false;
  return true;
}

static inline bool ts_str_eq(TS_Str a, TS_Str b) { return a.len == b.len && ts_mem_eq(a.ptr, b.ptr, a.len); }

/* FixedString<N> layout: u32 length (LE) then N bytes. Lengths past N are clamped on read. */
static inline TS_Str ts_fstr_view(const uint8_t *base, uint64_t cap) {
  uint32_t len;
  ts_memcpy(&len, base, 4);
  return ts_str(base + 4, len > cap ? cap : len);
}
static inline uint64_t ts_fstr_set(uint8_t *base, uint64_t cap, TS_Str v) {
  if (v.len > cap) TS_FAIL(TS_ERR_STRING_TOO_LONG, "TypeSOL: string longer than the field capacity");
  uint32_t len = (uint32_t)v.len;
  ts_memcpy(base, &len, 4);
  ts_memcpy(base + 4, v.ptr, v.len);
  ts_memzero(base + 4 + v.len, cap - v.len);
  return SUCCESS;
}

/* A Vec<T> instruction argument: elements are read with memcpy (instruction data is unaligned). */
typedef struct {
  const uint8_t *ptr;
  uint32_t len;
} TS_VecArg;

/*
 * ---- Entrypoint input ------------------------------------------------------
 * The loader's serialized input: u64 account count, then per account either a duplicate marker (u8 index of the
 * earlier account, 7 bytes padding) or u8 0xff, is_signer, is_writable, executable, 4 bytes padding, key, owner,
 * lamports, data_len, data, 10 KiB realloc room, padding to 8, rent_epoch; then u64 data length, data, program id.
 *
 * Generated code reads every account in place: a TsAccount is the serialized record itself, so parsing the input
 * stores one pointer per account instead of copying each field into a SolAccountInfo. Writes to lamports, owner,
 * data_len and data land directly where the runtime reads them back. A duplicate points at the earlier record.
 */
typedef struct {
  uint8_t dup; /* 0xff (not a duplicate) */
  bool is_signer;
  bool is_writable;
  bool executable;
  uint8_t padding[4];
  SolPubkey key;
  SolPubkey owner;
  uint64_t lamports;
  uint64_t data_len;
  uint8_t data[];
} TsAccount;
_Static_assert(__builtin_offsetof(TsAccount, key) == 8 && __builtin_offsetof(TsAccount, owner) == 40 &&
                   __builtin_offsetof(TsAccount, lamports) == 72 && __builtin_offsetof(TsAccount, data_len) == 80 &&
                   __builtin_offsetof(TsAccount, data) == 88,
               "TsAccount layout");

/* Accounts per instruction: the entry point refuses more (5113). */
#define TS_MAX_ACCOUNTS 32

/* Lives in the entry point's frame; the arrays are inline so setting it up stores nothing. */
typedef struct {
  uint64_t ka_num;
  const uint8_t *data; /* instruction data */
  uint64_t data_len;
  const SolPubkey *program_id;
  TsAccount *ka[TS_MAX_ACCOUNTS];             /* ka_num entries */
  SolAccountInfo infos[TS_MAX_ACCOUNTS];      /* scratch for CPI account lists (ts_invoke) */
} TsParams;

/*
 * Same bounds as the SDK's sol_deserialize, minus its per-account "past the array" branch: the entry point has
 * already refused counts above TS_MAX_ACCOUNTS (the size of `params->ka`), so every account fits.
 */
static inline __attribute__((always_inline)) void ts_deserialize(const uint8_t *input, TsParams *params) {
  uint64_t n = *(const uint64_t *)input;
  input += 8;
  params->ka_num = n;
  for (uint64_t i = 0; i < n; i++) {
    uint8_t dup = input[0];
    if (dup != UINT8_MAX) {
      params->ka[i] = params->ka[dup]; /* the loader only ever points back at an earlier account */
      input += 8;
      continue;
    }
    TsAccount *a = (TsAccount *)input;
    params->ka[i] = a;
    input = (const uint8_t *)(((uint64_t)(input + 88 + a->data_len + MAX_PERMITTED_DATA_INCREASE) + 7) & ~(uint64_t)7) + 8;
  }
  params->data_len = *(const uint64_t *)input;
  params->data = input + 8;
  params->program_id = (const SolPubkey *)(input + 8 + params->data_len);
}

/*
 * ---- CPI account lists -----------------------------------------------------
 * sol_invoke_signed takes SolAccountInfo records. They are built at the call, and only for the accounts the
 * instruction lists: every SolAccountMeta the runtime and generated code build points at the key inside an account
 * record (&a->key), so the record starts 8 bytes before it. Keys, owners, lamports and data point into the input,
 * which the runtime updates after the call. `params->infos` (room for every account) is the scratch space.
 */
static inline __attribute__((always_inline)) void ts_info(const TsAccount *a, SolAccountInfo *out) {
  out->key = (SolPubkey *)&a->key;
  out->lamports = (uint64_t *)&a->lamports;
  out->data_len = a->data_len;
  out->data = (uint8_t *)a->data;
  out->owner = (SolPubkey *)&a->owner;
  out->rent_epoch = 0; /* not read by the runtime (Pinocchio passes 0 too) */
  /* is_signer, is_writable, executable: adjacent in both layouts, so one 4-byte move copies all three (the fourth
     byte lands in SolAccountInfo's tail padding). */
  _Static_assert(__builtin_offsetof(SolAccountInfo, executable) == __builtin_offsetof(SolAccountInfo, is_signer) + 2 &&
                     __builtin_offsetof(SolAccountInfo, is_signer) + 4 <= sizeof(SolAccountInfo),
                 "SolAccountInfo flag layout");
  *(ts_u32_unaligned *)&out->is_signer = *(const ts_u32_unaligned *)&a->is_signer;
}

static inline __attribute__((always_inline)) uint64_t ts_invoke(TsParams *params, const SolInstruction *ix, const SolSignerSeeds *signers, int nsigners) {
  /* At most TS_MAX_ACCOUNTS metas (the compiler refuses longer lists), the size of `params->infos`. A repeated
     account gets a record per mention, which the runtime accepts. */
  SolAccountInfo *infos = params->infos;
  for (uint64_t i = 0; i < ix->account_len; i++) ts_info((const TsAccount *)((const uint8_t *)ix->accounts[i].pubkey - 8), &infos[i]);
  return sol_invoke_signed(ix, infos, ix->account_len, signers, nsigners);
}

/*
 * ---- Program derived addresses ------------------------------------------------
 * The same addresses sol_create_program_address / sol_try_find_program_address compute — sha256 of the seeds, the
 * program id and "ProgramDerivedAddress", valid only off the ed25519 curve — from the sha256 and curve-validation
 * syscalls, which cost a fraction of the 1500 compute units the PDA syscalls charge per attempt. The seed limits are the
 * syscalls' (at most 16 seeds of at most 32 bytes, the bump included), and so is the result for every input.
 */
uint64_t sol_curve_validate_point(uint64_t curve_id, const uint8_t *point, uint8_t *result);
#define TS_MAX_PDA_SEEDS 16

/* The address of `seeds` (and `bump`, when given) under `program`; false when it lies on the curve (no PDA). */
static inline bool ts_pda_hash(const SolSignerSeed *seeds, int n, const uint8_t *bump, const SolPubkey *program, SolPubkey *out) {
  SolBytes parts[TS_MAX_PDA_SEEDS + 2];
  int k = 0;
  for (int i = 0; i < n; i++) parts[k++] = (SolBytes){seeds[i].addr, seeds[i].len};
  if (bump) parts[k++] = (SolBytes){bump, 1};
  parts[k++] = (SolBytes){program->x, 32};
  parts[k++] = (SolBytes){(const uint8_t *)"ProgramDerivedAddress", 21};
  sol_sha256(parts, k, out->x);
  uint8_t ignored;
  return sol_curve_validate_point(0 /* CURVE25519_EDWARDS */, out->x, &ignored) != 0; /* 0: a valid curve point */
}

static inline bool ts_pda_seeds_ok(const SolSignerSeed *seeds, int n, int max) {
  if (n > max) return false;
  for (int i = 0; i < n; i++)
    if (seeds[i].len > 32) return false;
  return true;
}

/* sol_create_program_address: the bump is the last of `seeds`. */
static inline uint64_t ts_create_pda_address(const SolSignerSeed *seeds, int n, const SolPubkey *program, SolPubkey *out) {
  if (!ts_pda_seeds_ok(seeds, n, TS_MAX_PDA_SEEDS) || !ts_pda_hash(seeds, n, NULL, program, out)) return 1; /* not SUCCESS: the PDA syscalls fail the same inputs */
  return SUCCESS;
}

/* sol_try_find_program_address: the canonical (highest) bump. */
static inline uint64_t ts_find_pda(const SolSignerSeed *seeds, int n, const SolPubkey *program, SolPubkey *out, uint8_t *bump_out) {
  if (!ts_pda_seeds_ok(seeds, n, TS_MAX_PDA_SEEDS - 1)) return 1; /* not SUCCESS: the PDA syscalls fail the same inputs */
  for (int b = 255; b >= 0; b--) {
    uint8_t bump = (uint8_t)b;
    if (ts_pda_hash(seeds, n, &bump, program, out)) {
      *bump_out = bump;
      return SUCCESS;
    }
  }
  return 1; /* not SUCCESS: the PDA syscalls fail the same inputs */
}

/* ---- Account checks ------------------------------------------------------ */
/* Copy between two places of the same type: distinct, or the very same place (then nothing to do). */
static inline void ts_copy(void *dst, const void *src, uint64_t n) {
  if (dst != src) ts_memcpy(dst, src, n);
}

static inline __attribute__((always_inline)) bool ts_key_eq(const SolPubkey *a, const SolPubkey *b) {
  return ts_ld64(a->x) == ts_ld64(b->x) && ts_ld64(a->x + 8) == ts_ld64(b->x + 8) && ts_ld64(a->x + 16) == ts_ld64(b->x + 16) &&
         ts_ld64(a->x + 24) == ts_ld64(b->x + 24);
}

static inline uint64_t ts_check_signer(const TsAccount *a) {
  if (!a->is_signer) TS_FAIL(TS_ERR_NOT_SIGNER, "TypeSOL: account must sign");
  return SUCCESS;
}

static inline uint64_t ts_check_writable(const TsAccount *a) {
  if (!a->is_writable) TS_FAIL(TS_ERR_NOT_WRITABLE, "TypeSOL: account must be writable");
  return SUCCESS;
}

static inline uint64_t ts_check_program_account(const TsAccount *a, const SolPubkey *program_id,
                                                const uint8_t disc[8], uint64_t size) {
  /* Like Anchor: an empty system account (never created, or closed) is "not initialized". */
  if (a->lamports == 0 && ts_key_eq(&a->owner, &TS_SYSTEM_PROGRAM_ID)) TS_FAIL(TS_ERR_NOT_INITIALIZED, "TypeSOL: account is not initialized");
  if (!ts_key_eq(&a->owner, program_id)) TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: account not owned by this program");
  if (a->data_len < 8 + size) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: account data too small");
  if (!ts_mem_eq(a->data, disc, 8)) TS_FAIL(TS_ERR_DISCRIMINATOR, "TypeSOL: account discriminator mismatch");
  return SUCCESS;
}

/* An account ending in Vec<T>: data must be exactly fixed part + len * element size. */
static inline uint64_t ts_check_vec_len(const TsAccount *a, uint64_t fixed, uint32_t len, uint64_t elem) {
  if (a->data_len != 8 + fixed + (uint64_t)len * elem)
    TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: account size does not match its Vec length");
  return SUCCESS;
}

/* No other account in the instruction may be the same account (for loadAccountMut). */
static inline uint64_t ts_check_unaliased(const TsParams *params, const TsAccount *a) {
  /* The loader passes each account once and marks repeats as duplicates, which share its record. */
  uint64_t seen = 0;
  for (uint64_t i = 0; i < params->ka_num; i++) seen += params->ka[i] == a;
  if (seen > 1) TS_FAIL(TS_ERR_DUPLICATE_MUT, "TypeSOL: account passed more than once");
  return SUCCESS;
}

static inline uint64_t ts_check_address(const TsAccount *a, const SolPubkey *expected) {
  if (!ts_key_eq(&a->key, expected)) TS_FAIL(TS_ERR_WRONG_PROGRAM, "TypeSOL: unexpected program address");
  return SUCCESS;
}

static inline uint64_t ts_check_executable(const TsAccount *a) {
  if (!a->executable) TS_FAIL(TS_ERR_NOT_EXECUTABLE, "TypeSOL: account is not an executable program");
  return SUCCESS;
}

/*
 * SPL token account layout: mint[0..32] owner[32..64] amount[64..72] ... state[108].
 * Token-2022 keeps the same base and appends extensions after an account-type byte at [165]
 * (1 = mint, 2 = account). Mints are 82 bytes, or padded to 165 + type byte with extensions.
 */
#define TS_TOKEN_ACCOUNT_LEN 165
#define TS_MINT_LEN 82
static inline bool ts_is_token_program(const SolPubkey *k) {
  return ts_key_eq(k, &TS_TOKEN_PROGRAM_ID) || ts_key_eq(k, &TS_TOKEN_2022_PROGRAM_ID);
}
/* A Token-2022 Multisig is 355 bytes and its signer bytes are attacker-chosen: never accept that length. */
#define TS_MULTISIG_LEN 355
static inline uint64_t ts_check_token_account(const TsAccount *a) {
  bool ok = false;
  if (ts_key_eq(&a->owner, &TS_TOKEN_PROGRAM_ID)) ok = a->data_len == TS_TOKEN_ACCOUNT_LEN;
  else if (ts_key_eq(&a->owner, &TS_TOKEN_2022_PROGRAM_ID))
    ok = a->data_len == TS_TOKEN_ACCOUNT_LEN ||
         (a->data_len > TS_TOKEN_ACCOUNT_LEN && a->data_len != TS_MULTISIG_LEN && a->data[TS_TOKEN_ACCOUNT_LEN] == 2);
  else TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: token account not owned by a token program");
  if (!ok || a->data[108] == 0) TS_FAIL(TS_ERR_TOKEN_ACCOUNT, "TypeSOL: not an initialized token account");
  return SUCCESS;
}
/* Mint layout: mint_authority COption[0..36] supply[36..44] decimals[44] is_initialized[45] freeze[46..82] */
static inline uint64_t ts_check_mint(const TsAccount *a) {
  bool ok = false;
  if (ts_key_eq(&a->owner, &TS_TOKEN_PROGRAM_ID)) ok = a->data_len == TS_MINT_LEN;
  else if (ts_key_eq(&a->owner, &TS_TOKEN_2022_PROGRAM_ID))
    ok = a->data_len == TS_MINT_LEN ||
         (a->data_len > TS_TOKEN_ACCOUNT_LEN && a->data_len != TS_MULTISIG_LEN && a->data[TS_TOKEN_ACCOUNT_LEN] == 1);
  else TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: mint not owned by a token program");
  if (!ok || a->data[45] != 1) TS_FAIL(TS_ERR_MINT, "TypeSOL: not an initialized mint");
  return SUCCESS;
}
static inline uint64_t ts_check_token_program(const TsAccount *a) {
  if (!ts_is_token_program(&a->key)) TS_FAIL(TS_ERR_WRONG_PROGRAM, "TypeSOL: not a token program");
  return SUCCESS;
}
static inline const SolPubkey *ts_token_mint(const TsAccount *a) { return (const SolPubkey *)a->data; }
static inline const SolPubkey *ts_token_owner(const TsAccount *a) { return (const SolPubkey *)(a->data + 32); }
static inline uint64_t ts_token_amount(const TsAccount *a) {
  uint64_t v;
  ts_memcpy(&v, a->data + 64, 8);
  return v;
}

/* ---- Little-endian scalar IO (account data is packed Borsh) ------------- */
static inline uint64_t ts_read_le(const uint8_t *p, int n) {
  uint64_t v = 0;
  ts_memcpy(&v, p, n);
  return v;
}
static inline void ts_write_le(uint8_t *p, uint64_t v, int n) { ts_memcpy(p, &v, n); }

/* ---- Sysvars --------------------------------------------------------------- */
uint64_t sol_get_rent_sysvar(void *ret);
uint64_t sol_get_clock_sysvar(void *ret);

static inline uint64_t ts_minimum_balance(uint64_t data_len, uint64_t *out) {
  /* Rent { lamports_per_byte_year: u64, exemption_threshold: f64, burn_percent: u8 } */
  uint64_t rent[3] = {0};
  if (sol_get_rent_sysvar(rent) != SUCCESS) TS_FAIL(TS_ERR_SYSVAR, "TypeSOL: rent sysvar unavailable");
  uint64_t bytes, per_year;
  if (ts_add_overflow_u64(data_len, 128, &bytes) || ts_mul_overflow_u64(bytes, rent[0], &per_year))
    TS_FAIL(TS_ERR_OVERFLOW, "TypeSOL: arithmetic overflow");
  /* Fast path, bit-identical to the double math below: when the threshold is a positive whole number t (2.0 on
     every cluster) and per_year * t < 2^53, both factors and the product are exact doubles, so the integer product
     is the answer. Soft-float multiplication and conversions cost hundreds of CU; anything else takes that path. */
  uint64_t exp = (rent[1] >> 52) & 0x7ff;
  if (!(rent[1] >> 63) && exp >= 1023 && exp <= 1023 + 52) {
    uint64_t mant = (rent[1] & 0xfffffffffffffULL) | (1ULL << 52), frac = 52 - (exp - 1023), exact;
    if ((mant & ((1ULL << frac) - 1)) == 0 && !ts_mul_overflow_u64(per_year, mant >> frac, &exact) && exact < (1ULL << 53)) {
      *out = exact;
      return SUCCESS;
    }
  }
  double threshold;
  ts_memcpy(&threshold, &rent[1], 8);
  double lamports = (double)per_year * threshold;
  if (lamports >= 18446744073709551615.0) TS_FAIL(TS_ERR_OVERFLOW, "TypeSOL: arithmetic overflow");
  *out = (uint64_t)lamports;
  return SUCCESS;
}

/* Clock sysvar word `i`: 0 slot, 2 epoch (u64). */
static inline uint64_t ts_clock_u64(int i, uint64_t *out) {
  uint64_t clock[5] = {0};
  if (sol_get_clock_sysvar(clock) != SUCCESS) TS_FAIL(TS_ERR_SYSVAR, "TypeSOL: clock sysvar unavailable");
  *out = clock[i];
  return SUCCESS;
}

/* BPF upgradeable loader (BPFLoaderUpgradeab1e…) and this program's ProgramData account, PDA [program_id]. */
static const SolPubkey TS_BPF_UPGRADEABLE_LOADER_ID = {{2, 168, 246, 145, 78, 136, 161, 176, 226, 16, 21, 62, 247, 99, 174, 43, 0, 194, 185, 61, 22, 193, 36, 210, 192, 83, 122, 16, 4, 128, 0, 0}};
static inline uint64_t ts_check_program_data(const TsAccount *a, const SolPubkey *program_id) {
  if (!ts_key_eq(&a->owner, &TS_BPF_UPGRADEABLE_LOADER_ID)) TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: not owned by the upgradeable loader");
  if (a->data_len < 45 || ts_read_le(a->data, 4) != 3) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: not a ProgramData account");
  SolSignerSeed seed = {(const uint8_t *)program_id, 32};
  SolPubkey expected;
  uint8_t bump;
  if (ts_find_pda(&seed, 1, &TS_BPF_UPGRADEABLE_LOADER_ID, &expected, &bump) != SUCCESS || !ts_key_eq(&expected, &a->key))
    TS_FAIL(TS_ERR_ADDRESS, "TypeSOL: not this program's ProgramData account");
  return SUCCESS;
}

/* Anchor emit_cpi: the instruction-data tag of self-CPI events and the authority PDA ["__event_authority"]. */
static const uint8_t TS_EVENT_IX_TAG[8] = {0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d};
static inline uint64_t ts_check_event_authority(const TsAccount *a, const SolPubkey *program_id, uint8_t *bump) {
  SolSignerSeed seed = {(const uint8_t *)"__event_authority", 17};
  SolPubkey expected;
  if (ts_find_pda(&seed, 1, program_id, &expected, bump) != SUCCESS || !ts_key_eq(&expected, &a->key))
    TS_FAIL(TS_ERR_SEEDS, "TypeSOL: not this program's event authority");
  return SUCCESS;
}
static inline uint64_t ts_event_dispatch(TsParams *params) {
  if (params->ka_num < 1) TS_FAIL(TS_ERR_NOT_ENOUGH_ACCOUNTS, "TypeSOL: not enough accounts");
  if (!params->ka[0]->is_signer) TS_FAIL(TS_ERR_CONSTRAINT_SIGNER, "TypeSOL: the event authority must sign");
  uint8_t bump;
  return ts_check_event_authority(params->ka[0], params->program_id, &bump);
}

static inline uint64_t ts_now(int64_t *out) {
  /* Clock { slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp } */
  uint64_t clock[5] = {0};
  if (sol_get_clock_sysvar(clock) != SUCCESS) TS_FAIL(TS_ERR_SYSVAR, "TypeSOL: clock sysvar unavailable");
  *out = (int64_t)clock[4];
  return SUCCESS;
}

/*
 * Zeroed<T>: a large account the client allocated with System CreateAccount (up to 10 MiB) and assigned
 * to this program. It must be writable, rent-exempt, big enough and still all-zero in its discriminator;
 * the discriminator is written here so the account can never be initialized twice.
 */
static inline uint64_t ts_init_zeroed(TsAccount *a, const SolPubkey *program_id, const uint8_t disc[8], uint64_t size) {
  if (!ts_key_eq(&a->owner, program_id)) TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: account not owned by this program");
  if (a->data_len < 8 + size) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: account data too small");
  if (ts_ld64(a->data) != 0) TS_FAIL(TS_ERR_ALREADY_INITIALIZED, "TypeSOL: account already initialized");
  uint64_t need;
  TS_TRY(ts_minimum_balance(a->data_len, &need));
  if (a->lamports < need) TS_FAIL(TS_ERR_NOT_RENT_EXEMPT, "TypeSOL: account is not rent-exempt");
  ts_memcpy(a->data, disc, 8);
  return SUCCESS;
}

/* ---- PDA ----------------------------------------------------------------- */
static inline uint64_t ts_require_pda(const TsAccount *a, const SolSignerSeed *seeds, int n,
                                      const SolPubkey *program_id) {
  SolPubkey derived;
  if (ts_create_pda_address(seeds, n, program_id, &derived) != SUCCESS || !ts_key_eq(&derived, &a->key))
    TS_FAIL(TS_ERR_SEEDS, "TypeSOL: PDA seeds do not match account");
  return SUCCESS;
}

/* ---- System program CPIs ------------------------------------------------- */
static inline uint64_t ts_system_transfer(TsParams *params, TsAccount *from, TsAccount *to,
                                          uint64_t lamports) {
  uint8_t data[12];
  uint32_t tag = 2;
  ts_memcpy(data, &tag, 4);
  ts_memcpy(data + 4, &lamports, 8);
  SolAccountMeta metas[2] = {{&from->key, true, true}, {&to->key, true, false}};
  SolInstruction ix = {(SolPubkey *)&TS_SYSTEM_PROGRAM_ID, metas, 2, data, sizeof(data)};
  return ts_invoke(params, &ix, NULL, 0);
}

/*
 * Create `acct` as a PDA of this program. `seeds` must have room for one extra
 * entry: the bump is appended there. Writes the discriminator on success.
 */
static inline uint64_t ts_create_pda(TsParams *params, TsAccount *payer, TsAccount *acct,
                                     SolSignerSeed *seeds, int n, const uint8_t disc[8], uint64_t space,
                                     uint8_t *bump_out) {
  SolPubkey derived;
  uint8_t bump;
  if (ts_find_pda(seeds, n, params->program_id, &derived, &bump) != SUCCESS ||
      !ts_key_eq(&derived, &acct->key))
    TS_FAIL(TS_ERR_SEEDS, "TypeSOL: PDA seeds do not match account");
  if (acct->data_len != 0 || !ts_key_eq(&acct->owner, &TS_SYSTEM_PROGRAM_ID))
    TS_FAIL(TS_ERR_ALREADY_INITIALIZED, "TypeSOL: account already exists");
  uint64_t lamports;
  TS_TRY(ts_minimum_balance(space, &lamports));
  seeds[n].addr = &bump;
  seeds[n].len = 1;
  SolSignerSeeds signer = {seeds, (uint64_t)(n + 1)};

  if (acct->lamports == 0) {
    uint8_t data[52];
    uint32_t tag = 0; /* CreateAccount */
    ts_memcpy(data, &tag, 4);
    ts_memcpy(data + 4, &lamports, 8);
    ts_memcpy(data + 12, &space, 8);
    ts_memcpy(data + 20, params->program_id, 32);
    SolAccountMeta metas[2] = {{&payer->key, true, true}, {&acct->key, true, true}};
    SolInstruction ix = {(SolPubkey *)&TS_SYSTEM_PROGRAM_ID, metas, 2, data, sizeof(data)};
    TS_TRY(ts_invoke(params, &ix, &signer, 1));
  } else {
    /* Someone pre-funded the address (CreateAccount would fail): top up, allocate, assign. */
    if (acct->lamports < lamports) TS_TRY(ts_system_transfer(params, payer, acct, lamports - acct->lamports));
    uint8_t alloc[12];
    uint32_t alloc_tag = 8; /* Allocate */
    ts_memcpy(alloc, &alloc_tag, 4);
    ts_memcpy(alloc + 4, &space, 8);
    SolAccountMeta one[1] = {{&acct->key, true, true}};
    SolInstruction alloc_ix = {(SolPubkey *)&TS_SYSTEM_PROGRAM_ID, one, 1, alloc, sizeof(alloc)};
    TS_TRY(ts_invoke(params, &alloc_ix, &signer, 1));
    uint8_t assign[36];
    uint32_t assign_tag = 1; /* Assign */
    ts_memcpy(assign, &assign_tag, 4);
    ts_memcpy(assign + 4, params->program_id, 32);
    SolInstruction assign_ix = {(SolPubkey *)&TS_SYSTEM_PROGRAM_ID, one, 1, assign, sizeof(assign)};
    TS_TRY(ts_invoke(params, &assign_ix, &signer, 1));
  }

  acct->data_len = space;
  ts_memcpy(acct->data, disc, 8);
  *bump_out = bump;
  return SUCCESS;
}

/*
 * Resize a program-owned account to `new_len` bytes (realloc). Growth is limited to 10 KiB past the
 * size the account had when the instruction started; new bytes are zeroed. When growing, `payer`
 * tops up the rent-exempt minimum through the System Program.
 */
static inline uint64_t ts_resize(TsParams *params, TsAccount *payer, TsAccount *acct, uint64_t new_len,
                                 uint64_t entry_len) {
  if (new_len > entry_len + MAX_PERMITTED_DATA_INCREASE)
    TS_FAIL(TS_ERR_REALLOC, "TypeSOL: account would grow more than 10 KiB in one instruction");
  uint64_t old_len = acct->data_len;
  if (new_len > old_len) {
    /* The payer always funds the extra rent, even when the account already holds enough lamports: those may be
       deposits, which must not become rent (and shrinking never pays anything back, see ts_realloc). */
    uint64_t old_rent, new_rent;
    TS_TRY(ts_minimum_balance(old_len, &old_rent));
    TS_TRY(ts_minimum_balance(new_len, &new_rent));
    if (new_rent > old_rent) {
      if (payer == NULL) TS_FAIL(TS_ERR_REALLOC, "TypeSOL: growing an account needs a payer");
      TS_TRY(ts_system_transfer(params, payer, acct, new_rent - old_rent));
    }
    ts_memzero(acct->data + old_len, new_len - old_len);
  }
  acct->data_len = new_len;
  return SUCCESS;
}

/*
 * InitIfNeeded: create the PDA like ts_create_pda, or accept it when it already exists as this program's
 * account of the right type (owner, discriminator, size). The PDA is re-derived either way.
 */
/* realloc(): resize, keep at least `min_len`, refund the rent no longer needed to the payer on shrink. */
static inline uint64_t ts_realloc(TsParams *params, TsAccount *payer, TsAccount *acct, uint64_t new_len,
                                  uint64_t entry_len, uint64_t min_len) {
  if (new_len < min_len) TS_FAIL(TS_ERR_REALLOC, "TypeSOL: realloc below the account's struct size");
  /* Shrinking leaves every lamport in the account: who paid which rent is unknown here, so refunding the caller
     would let anyone grow-then-shrink their way into other people's deposits. The program can move the freed
     rent out itself (lamports), under its own authorization. */
  return ts_resize(params, payer, acct, new_len, entry_len);
}

static inline uint64_t ts_create_pda_if_needed(TsParams *params, TsAccount *payer, TsAccount *acct,
                                               SolSignerSeed *seeds, int n, const uint8_t disc[8], uint64_t space,
                                               uint8_t *bump_out, bool *created) {
  if (ts_key_eq(&acct->owner, params->program_id)) {
    SolPubkey derived;
    uint8_t bump;
    if (ts_find_pda(seeds, n, params->program_id, &derived, &bump) != SUCCESS ||
        !ts_key_eq(&derived, &acct->key))
      TS_FAIL(TS_ERR_SEEDS, "TypeSOL: PDA seeds do not match account");
    if (acct->data_len < space) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: account data too small");
    if (!ts_mem_eq(acct->data, disc, 8)) TS_FAIL(TS_ERR_DISCRIMINATOR, "TypeSOL: account discriminator mismatch");
    *bump_out = bump;
    *created = false;
    return SUCCESS;
  }
  *created = true;
  return ts_create_pda(params, payer, acct, seeds, n, disc, space, bump_out);
}

/* Move every lamport to `dest`, zero the data, shrink to 0 and hand back to System. */
static inline uint64_t ts_close(TsAccount *acct, TsAccount *dest) {
  uint64_t total;
  if (ts_add_overflow_u64(dest->lamports, acct->lamports, &total))
    TS_FAIL(TS_ERR_OVERFLOW, "TypeSOL: arithmetic overflow");
  dest->lamports = total;
  acct->lamports = 0;
  ts_memzero(acct->data, acct->data_len);
  acct->data_len = 0;
  ts_memcpy(&acct->owner, &TS_SYSTEM_PROGRAM_ID, 32);
  return SUCCESS;
}

/* A CPI to `program` (an account passed in), signed by one PDA when `nseeds` > 0. */
static inline uint64_t ts_cpi(TsParams *params, const TsAccount *program, uint8_t *data, uint64_t len,
                              SolAccountMeta *metas, uint64_t n, const SolSignerSeed *seeds, int nseeds) {
  SolInstruction ix = {(SolPubkey *)&program->key, metas, n, data, len};
  SolSignerSeeds signer = {seeds, (uint64_t)nseeds};
  return ts_invoke(params, &ix, &signer, nseeds > 0 ? 1 : 0);
}

/* ---- Token-2022 extensions (TLV after the 165-byte base and the account-type byte) ---- */
/* `a` must be a token-program mint (want 1) or account (want 2), or either (want 0): legacy SPL Token accounts
   simply have no extensions; a Token-2022 multisig or a foreign account is refused. */
static inline uint64_t ts_t22_layout(const TsAccount *a, uint8_t want) {
  bool t22 = ts_key_eq(&a->owner, &TS_TOKEN_2022_PROGRAM_ID);
  if (!t22 && !ts_key_eq(&a->owner, &TS_TOKEN_PROGRAM_ID)) TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: not a token program account");
  uint64_t n = a->data_len;
  if (n == TS_MULTISIG_LEN) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: a multisig, not a mint or token account");
  uint8_t kind;
  if (n == TS_MINT_LEN) kind = 1;
  else if (n == TS_TOKEN_ACCOUNT_LEN) kind = 2;
  else if (t22 && n > TS_TOKEN_ACCOUNT_LEN) kind = a->data[TS_TOKEN_ACCOUNT_LEN];
  else kind = 0;
  if ((kind != 1 && kind != 2) || (want != 0 && kind != want))
    TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, want == 1 ? "TypeSOL: not a mint" : "TypeSOL: not a mint or token account");
  return SUCCESS;
}

static inline bool ts_t22_ext(const TsAccount *a, uint16_t type, uint64_t *off, uint64_t *len) {
  if (!ts_key_eq(&a->owner, &TS_TOKEN_2022_PROGRAM_ID) || a->data_len <= TS_TOKEN_ACCOUNT_LEN + 1) return false;
  uint64_t at = TS_TOKEN_ACCOUNT_LEN + 1;
  while (at + 4 <= a->data_len) {
    uint16_t t = (uint16_t)ts_read_le(a->data + at, 2);
    uint16_t n = (uint16_t)ts_read_le(a->data + at + 2, 2);
    if (t == 0) return false; /* uninitialized: end of the entries */
    if (at + 4 + n > a->data_len) return false;
    if (t == type) {
      *off = at + 4;
      *len = n;
      return true;
    }
    at += 4 + (uint64_t)n;
  }
  return false;
}

/* An OptionalNonZeroPubkey at `field` of extension `type` (zero means none). */
static inline bool ts_t22_key(const TsAccount *a, uint16_t type, uint64_t field, SolPubkey *out) {
  uint64_t off, len;
  if (!ts_t22_ext(a, type, &off, &len) || len < field + 32) return false;
  ts_memcpy(out, a->data + off + field, 32);
  static const SolPubkey zero = {{0}};
  return !ts_key_eq(out, &zero);
}

/* The transfer fee on `amount` for the current epoch (TransferFeeConfig, extension 1), like spl-token-2022. */
static inline uint64_t ts_t22_transfer_fee(const TsAccount *mint, uint64_t amount, uint64_t *out) {
  uint64_t off, len;
  *out = 0;
  if (!ts_t22_ext(mint, 1, &off, &len) || len < 108) return SUCCESS;
  uint64_t epoch;
  TS_TRY(ts_clock_u64(2, &epoch));
  const uint8_t *newer = mint->data + off + 90;
  const uint8_t *fee = epoch >= ts_read_le(newer, 8) ? newer : mint->data + off + 72;
  uint64_t maximum = ts_read_le(fee + 8, 8);
  uint64_t bps = ts_read_le(fee + 16, 2);
  if (bps == 0 || amount == 0) return SUCCESS;
  unsigned __int128 raw = ((unsigned __int128)amount * bps + 9999) / 10000;
  *out = raw > maximum ? maximum : (uint64_t)raw;
  return SUCCESS;
}

/* ---- Metaplex Core and Bubblegum ----------------------------------------- */
static const SolPubkey TS_MPL_CORE_ID = {{175, 84, 171, 16, 189, 151, 165, 66, 160, 158, 247, 179, 152, 137, 221, 12, 211, 148, 164, 204, 233, 223, 166, 205, 201, 126, 190, 45, 35, 91, 167, 72}};
static const SolPubkey TS_BUBBLEGUM_ID = {{152, 139, 128, 235, 121, 53, 40, 105, 178, 36, 116, 95, 89, 221, 191, 138, 38, 88, 202, 19, 220, 104, 129, 33, 38, 53, 28, 174, 7, 193, 165, 165}};

/* A Core asset (Key::AssetV1 = 1, owner at 1, update authority enum at 33: 2 = Collection + key). */
static inline uint64_t ts_core_asset(const TsAccount *a) {
  if (!ts_key_eq(&a->owner, &TS_MPL_CORE_ID)) TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: not a Metaplex Core account");
  if (a->data_len < 34 || a->data[0] != 1) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: not a Metaplex Core asset");
  return SUCCESS;
}

/* ---- SPL Token / Token-2022 CPIs ---------------------------------------- */
/* `program` is the token program account passed in (Tokenkeg or Token-2022). */
static inline uint64_t ts_token_cpi(TsParams *params, const TsAccount *program, uint8_t *data, uint64_t len,
                                    SolAccountMeta *metas, uint64_t n, const SolSignerSeed *seeds, int nseeds) {
  SolInstruction ix = {(SolPubkey *)&program->key, metas, n, data, len};
  SolSignerSeeds signer = {seeds, (uint64_t)nseeds};
  return ts_invoke(params, &ix, &signer, nseeds > 0 ? 1 : 0);
}

static inline uint64_t ts_token_transfer(TsParams *params, const TsAccount *program, TsAccount *from,
                                         TsAccount *to, TsAccount *authority, uint64_t amount,
                                         const SolSignerSeed *seeds, int n) {
  uint8_t data[9] = {3}; /* Transfer */
  ts_memcpy(data + 1, &amount, 8);
  SolAccountMeta metas[3] = {{&from->key, true, false}, {&to->key, true, false}, {&authority->key, false, true}};
  return ts_token_cpi(params, program, data, sizeof(data), metas, 3, seeds, n);
}

static inline uint64_t ts_token_transfer_checked(TsParams *params, const TsAccount *program,
                                                 TsAccount *from, TsAccount *mint, TsAccount *to,
                                                 TsAccount *authority, uint64_t amount, const SolSignerSeed *seeds,
                                                 int n) {
  uint8_t data[10] = {12}; /* TransferChecked */
  ts_memcpy(data + 1, &amount, 8);
  data[9] = mint->data[44];
  SolAccountMeta metas[4] = {
      {&from->key, true, false}, {&mint->key, false, false}, {&to->key, true, false}, {&authority->key, false, true}};
  return ts_token_cpi(params, program, data, sizeof(data), metas, 4, seeds, n);
}

static inline uint64_t ts_token_mint_to(TsParams *params, const TsAccount *program, TsAccount *mint,
                                        TsAccount *to, TsAccount *authority, uint64_t amount,
                                        const SolSignerSeed *seeds, int n) {
  uint8_t data[9] = {7}; /* MintTo */
  ts_memcpy(data + 1, &amount, 8);
  SolAccountMeta metas[3] = {{&mint->key, true, false}, {&to->key, true, false}, {&authority->key, false, true}};
  return ts_token_cpi(params, program, data, sizeof(data), metas, 3, seeds, n);
}

static inline uint64_t ts_token_burn(TsParams *params, const TsAccount *program, TsAccount *from,
                                     TsAccount *mint, TsAccount *authority, uint64_t amount,
                                     const SolSignerSeed *seeds, int n) {
  uint8_t data[9] = {8}; /* Burn */
  ts_memcpy(data + 1, &amount, 8);
  SolAccountMeta metas[3] = {{&from->key, true, false}, {&mint->key, true, false}, {&authority->key, false, true}};
  return ts_token_cpi(params, program, data, sizeof(data), metas, 3, seeds, n);
}

static inline uint64_t ts_token_close(TsParams *params, const TsAccount *program, TsAccount *account,
                                      TsAccount *dest, TsAccount *authority, const SolSignerSeed *seeds, int n) {
  uint8_t data[1] = {9}; /* CloseAccount */
  SolAccountMeta metas[3] = {{&account->key, true, false}, {&dest->key, true, false}, {&authority->key, false, true}};
  return ts_token_cpi(params, program, data, sizeof(data), metas, 3, seeds, n);
}

/* ---- Return data ----------------------------------------------------------- */
static inline uint64_t ts_return_data(const TsAccount *program, uint8_t *out, uint64_t size) {
  uint8_t buf[32];
  SolPubkey from;
  uint64_t n = sol_get_return_data(buf, sizeof(buf), &from);
  if (n != size || !ts_key_eq(&from, &program->key))
    TS_FAIL(TS_ERR_RETURN_DATA, "TypeSOL: missing or mismatched return data");
  ts_memcpy(out, buf, size);
  return SUCCESS;
}

/* ---- Crypto ---------------------------------------------------------------- */
static const SolPubkey TS_ED25519_PROGRAM_ID = {{3,125,70,214,124,147,251,190,18,249,66,143,131,141,64,255,5,112,116,73,39,244,138,100,252,202,112,68,128,0,0,0}};
static const SolPubkey TS_INSTRUCTIONS_SYSVAR_ID = {{6,167,213,23,24,123,209,102,53,218,212,4,85,253,194,192,193,36,198,143,33,86,117,165,219,186,203,95,8,0,0,0}};

/*
 * Merkle proof over keccak256 with sorted pairs (the OpenZeppelin MerkleProof convention used by most
 * airdrop tooling): node = keccak(min(a, b) || max(a, b)). `proof` holds `n` 32-byte siblings, unaligned.
 */
/*
 * Lexicographic byte order. (The SDK's sol_memcmp only answers "equal or not": it returns the
 * difference as uint8_t, so any difference is positive.)
 */
static inline int ts_bytes_cmp(const uint8_t *a, const uint8_t *b, uint64_t n) {
  for (uint64_t i = 0; i < n; i++)
    if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

static inline bool ts_merkle_verify(const SolPubkey *leaf, const uint8_t *proof, uint32_t n, const SolPubkey *root) {
  uint8_t node[32];
  ts_memcpy(node, leaf, 32);
  for (uint32_t i = 0; i < n; i++) {
    uint8_t sib[32];
    ts_memcpy(sib, proof + (uint64_t)i * 32, 32);
    SolBytes pair[2];
    bool node_first = ts_bytes_cmp(node, sib, 32) <= 0;
    pair[0].addr = node_first ? node : sib;
    pair[1].addr = node_first ? sib : node;
    pair[0].len = 32;
    pair[1].len = 32;
    uint8_t out[32];
    sol_keccak256(pair, 2, out);
    ts_memcpy(node, out, 32);
  }
  return ts_mem_eq(node, root, 32);
}

/*
 * Did an Ed25519 precompile instruction in this transaction verify `message` signed by `signer`?
 * Reads the Instructions sysvar (data: u16 count, u16 offsets[count], then per instruction
 * u16 num_accounts, num_accounts * (u8 flags, 32-byte key), 32-byte program id, u16 data_len, data).
 * The precompile has already checked the signature itself; we check it was over our pubkey and
 * message, with offsets pointing into the precompile's own data (instruction index 0xFFFF).
 */
static inline bool ts_ed25519_verified(const TsAccount *ixs, const SolPubkey *signer, TS_Str message) {
  const uint8_t *d = ixs->data;
  uint64_t len = ixs->data_len;
  if (len < 2) return false;
  uint16_t count;
  ts_memcpy(&count, d, 2);
  if (2 + (uint64_t)count * 2 > len) return false;
  for (uint16_t i = 0; i < count; i++) {
    uint16_t at;
    ts_memcpy(&at, d + 2 + (uint64_t)i * 2, 2);
    uint64_t p = at;
    if (p + 2 > len) return false;
    uint16_t nacc;
    ts_memcpy(&nacc, d + p, 2);
    p += 2 + (uint64_t)nacc * 33;
    if (p + 34 > len) return false;
    bool is_ed = ts_mem_eq(d + p, &TS_ED25519_PROGRAM_ID, 32);
    p += 32;
    uint16_t dlen;
    ts_memcpy(&dlen, d + p, 2);
    p += 2;
    if (p + dlen > len) return false;
    if (!is_ed || dlen < 2) continue;
    const uint8_t *ix = d + p;
    uint8_t nsig = ix[0];
    for (uint8_t k = 0; k < nsig; k++) {
      uint64_t o = 2 + (uint64_t)k * 14;
      if (o + 14 > dlen) break;
      uint16_t f[7];
      ts_memcpy(f, ix + o, 14); /* sig_off, sig_ix, pk_off, pk_ix, msg_off, msg_len, msg_ix */
      if (f[1] != 0xFFFF || f[3] != 0xFFFF || f[6] != 0xFFFF) continue;
      if ((uint64_t)f[2] + 32 > dlen || (uint64_t)f[4] + f[5] > dlen) continue;
      if (!ts_mem_eq(ix + f[2], signer, 32)) continue;
      if (f[5] != message.len || !ts_mem_eq(ix + f[4], message.ptr, message.len)) continue;
      return true;
    }
  }
  return false;
}

/* secp256k1: recover the signer of `hash` and compare with an Ethereum address left-padded to 32 bytes. */
static inline bool ts_secp256k1_verify(const SolPubkey *hash, uint64_t recovery_id, const SolPubkey *r, const SolPubkey *s,
                                       const SolPubkey *eth_address) {
  uint8_t sig[64];
  ts_memcpy(sig, r, 32);
  ts_memcpy(sig + 32, s, 32);
  /* Reject high-s signatures: (r, n - s) would otherwise verify too (malleability). */
  static const uint8_t half_n[32] = {0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
                                     0xff, 0xff, 0xff, 0xff, 0xff, 0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4,
                                     0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0};
  if (ts_bytes_cmp((const uint8_t *)s, half_n, 32) > 0) return false;
  uint8_t pub[64];
  if (sol_secp256k1_recover((const uint8_t *)hash, recovery_id, sig, pub) != 0) return false;
  SolBytes b = {pub, 64};
  uint8_t h[32];
  sol_keccak256(&b, 1, h);
  static const uint8_t zero12[12] = {0};
  return ts_mem_eq(eth_address, zero12, 12) && ts_mem_eq((const uint8_t *)eth_address + 12, h + 12, 20);
}

/* ---- Heap: a bump allocator for strings built at runtime ----------------- */
/* The first 8 bytes of the 32 KiB heap hold the next free offset (the heap starts zeroed). */
/* The heap the program may use: 32 KiB, or what `const HEAP_SIZE_KIB = …` declared (clients must then request
   that heap frame with ComputeBudget requestHeapFrame). */
#ifndef TS_HEAP_LENGTH
#define TS_HEAP_LENGTH HEAP_LENGTH
#endif
static inline uint64_t ts_alloc(uint64_t n, uint8_t **out) {
  uint64_t *next = (uint64_t *)HEAP_START_ADDRESS;
  uint64_t at = *next == 0 ? 8 : *next;
  at = (at + 7) & ~(uint64_t)7;
  if (at + n > TS_HEAP_LENGTH) TS_FAIL(TS_ERR_HEAP, "TypeSOL: out of heap");
  *next = at + n;
  *out = (uint8_t *)(HEAP_START_ADDRESS + at);
  return SUCCESS;
}

static inline uint64_t ts_str_concat(TS_Str a, TS_Str b, TS_Str *out) {
  uint8_t *p;
  TS_TRY(ts_alloc(a.len + b.len, &p));
  ts_memcpy(p, a.ptr, a.len);
  ts_memcpy(p + a.len, b.ptr, b.len);
  *out = ts_str(p, a.len + b.len);
  return SUCCESS;
}

/* Decimal text of an integer, on the heap. */
/* Copy a string's bytes to the heap (a stable value, independent of where the view pointed). */
static inline uint64_t ts_str_copy(TS_Str a, TS_Str *out) {
  uint8_t *p;
  TS_TRY(ts_alloc(a.len, &p));
  ts_memcpy(p, a.ptr, a.len);
  *out = ts_str(p, a.len);
  return SUCCESS;
}

/* floor or ceil of a * b / c through a 128-bit product; fails on c == 0 or a result above u64. */
static inline uint64_t ts_mul_div(uint64_t a, uint64_t b, uint64_t c, bool ceil, uint64_t *out) {
  if (c == 0) TS_FAIL(TS_ERR_DIV_ZERO, "TypeSOL: division by zero");
  unsigned __int128 p = (unsigned __int128)a * b;
  unsigned __int128 q = p / c;
  if (ceil && p % c != 0) q += 1;
  if (q > UINT64_MAX) TS_FAIL(TS_ERR_OVERFLOW, "TypeSOL: arithmetic overflow");
  *out = (uint64_t)q;
  return SUCCESS;
}

/* Integer square roots (floor), by Newton's method from an over-estimate. */
static inline uint64_t ts_isqrt_u64(uint64_t x) {
  if (x < 2) return x;
  uint64_t r = (uint64_t)1 << ((64 - __builtin_clzll(x) + 1) / 2);
  while (1) {
    uint64_t n = (r + x / r) / 2;
    if (n >= r) return r;
    r = n;
  }
}
static inline unsigned __int128 ts_isqrt_u128(unsigned __int128 x) {
  if (x < 2) return x;
  uint64_t hi = (uint64_t)(x >> 64);
  int bits = hi ? 128 - __builtin_clzll(hi) : 64 - __builtin_clzll((uint64_t)x);
  unsigned __int128 r = (unsigned __int128)1 << ((bits + 1) / 2);
  while (1) {
    unsigned __int128 n = (r + x / r) / 2;
    if (n >= r) return r;
    r = n;
  }
}

/* Decimal text of a 128-bit integer on the heap. */
static inline uint64_t ts_str_u128(unsigned __int128 v, bool negative, TS_Str *out) {
  char tmp[40];
  int n = 0;
  do {
    tmp[n++] = (char)('0' + (int)(v % 10));
    v /= 10;
  } while (v);
  if (negative) tmp[n++] = '-';
  uint8_t *p;
  TS_TRY(ts_alloc((uint64_t)n, &p));
  for (int i = 0; i < n; i++) p[i] = (uint8_t)tmp[n - 1 - i];
  *out = ts_str(p, (uint64_t)n);
  return SUCCESS;
}
static inline uint64_t ts_str_i128(__int128 v, TS_Str *out) {
  unsigned __int128 mag = v < 0 ? (unsigned __int128)0 - (unsigned __int128)v : (unsigned __int128)v;
  return ts_str_u128(mag, v < 0, out);
}

static inline uint64_t ts_str_u64(uint64_t v, bool negative, TS_Str *out) {
  uint8_t tmp[21];
  int n = 0;
  do {
    tmp[n++] = (uint8_t)('0' + v % 10);
    v /= 10;
  } while (v);
  if (negative) tmp[n++] = '-';
  uint8_t *p;
  TS_TRY(ts_alloc((uint64_t)n, &p));
  for (int i = 0; i < n; i++) p[i] = tmp[n - 1 - i];
  *out = ts_str(p, (uint64_t)n);
  return SUCCESS;
}
static inline uint64_t ts_str_i64(int64_t v, TS_Str *out) {
  uint64_t mag = v < 0 ? (uint64_t)(-(v + 1)) + 1 : (uint64_t)v;
  return ts_str_u64(mag, v < 0, out);
}

/* ---- Oracles ------------------------------------------------------------------ */
/* Pyth Solana Receiver (rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ), PriceUpdateV2 accounts. */
static const SolPubkey TS_PYTH_RECEIVER_ID = {{12,183,250,187,82,247,166,72,187,91,49,125,154,1,139,144,87,203,2,71,116,250,254,1,230,196,223,152,204,56,88,129}};
static const uint8_t TS_PYTH_PRICE_UPDATE_DISC[8] = {34, 241, 35, 99, 157, 126, 244, 205};

/*
 * PriceUpdateV2 (Borsh): disc 8 | write_authority 32 | verification_level (enum: 0 Partial{u8} = 2 bytes,
 * 1 Full = 1 byte) | PriceFeedMessage { feed_id 32, price i64, conf u64, exponent i32, publish_time i64,
 * prev_publish_time i64, ema_price i64, ema_conf u64 } | posted_slot u64. Returns the message offset.
 */
static inline uint64_t ts_pyth_message(const TsAccount *a, uint64_t *msg, bool *full) {
  if (!ts_key_eq(&a->owner, &TS_PYTH_RECEIVER_ID)) TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: not a Pyth price update (owner)");
  if (a->data_len < 8 + 32 + 1 + 84 || !ts_mem_eq(a->data, TS_PYTH_PRICE_UPDATE_DISC, 8))
    TS_FAIL(TS_ERR_DISCRIMINATOR, "TypeSOL: not a Pyth PriceUpdateV2 account");
  uint8_t level = a->data[40];
  if (level == 0) *msg = 42;
  else if (level == 1) *msg = 41;
  else TS_FAIL(TS_ERR_ORACLE, "TypeSOL: bad Pyth verification level");
  if (a->data_len < *msg + 84) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: Pyth price update too small");
  *full = level == 1;
  return SUCCESS;
}
static inline int64_t ts_le_i64(const uint8_t *p) {
  int64_t v;
  ts_memcpy(&v, p, 8);
  return v;
}

/* Like get_price_no_older_than: fully verified, matching feed id, publish_time + max_age >= now. */
static inline uint64_t ts_pyth_price(const TsAccount *a, const SolPubkey *feed, uint64_t max_age, int64_t *out) {
  uint64_t m;
  bool full;
  TS_TRY(ts_pyth_message(a, &m, &full));
  if (!full) TS_FAIL(TS_ERR_ORACLE, "TypeSOL: Pyth update is not fully verified");
  if (!ts_mem_eq(a->data + m, feed, 32)) TS_FAIL(TS_ERR_ORACLE, "TypeSOL: Pyth feed id mismatch");
  int64_t now;
  TS_TRY(ts_now(&now));
  int64_t published = ts_le_i64(a->data + m + 52);
  int64_t deadline;
  if (__builtin_add_overflow(published, (int64_t)(max_age > INT64_MAX ? INT64_MAX : max_age), &deadline)) deadline = INT64_MAX;
  if (deadline < now) TS_FAIL(TS_ERR_ORACLE, "TypeSOL: Pyth price is too old");
  *out = ts_le_i64(a->data + m + 32);
  return SUCCESS;
}

/* Switchboard On-Demand PullFeedAccountData (zero-copy, repr(C)). */
static const SolPubkey TS_SWITCHBOARD_MAINNET_ID = {{6,115,189,70,242,228,126,4,241,43,217,47,183,49,150,142,205,157,151,87,194,116,218,135,71,111,70,92,4,12,101,115}};
static const SolPubkey TS_SWITCHBOARD_DEVNET_ID = {{144,110,20,100,197,248,183,99,60,192,90,66,76,221,179,174,205,109,171,184,174,199,71,188,79,62,17,48,30,64,99,203}};
static const uint8_t TS_SWITCHBOARD_FEED_DISC[8] = {196, 27, 108, 196, 10, 215, 219, 40};
/* Offsets in account data (8-byte discriminator + struct): result.value (i128), result.num_samples, result.slot. */
#define TS_SB_RESULT_VALUE (8 + 2256)
#define TS_SB_RESULT_SAMPLES (8 + 2256 + 96)
#define TS_SB_RESULT_SLOT (8 + 2256 + 104)

static inline uint64_t ts_check_switchboard(const TsAccount *a, bool devnet) {
  if (!ts_key_eq(&a->owner, devnet ? &TS_SWITCHBOARD_DEVNET_ID : &TS_SWITCHBOARD_MAINNET_ID))
    TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: not a Switchboard feed (owner)");
  if (a->data_len < TS_SB_RESULT_SLOT + 8 || !ts_mem_eq(a->data, TS_SWITCHBOARD_FEED_DISC, 8))
    TS_FAIL(TS_ERR_DISCRIMINATOR, "TypeSOL: not a Switchboard PullFeedAccountData account");
  return SUCCESS;
}

/*
 * The feed's current result (an 18-decimal fixed-point i128) scaled to `decimals`, if it has samples
 * and was produced within `max_stale_slots` slots of now.
 */
static inline uint64_t ts_switchboard_value(const TsAccount *a, uint64_t max_stale_slots, uint8_t decimals, int64_t *out) {
  if (decimals > 18) TS_FAIL(TS_ERR_ORACLE, "TypeSOL: at most 18 decimals");
  if (a->data[TS_SB_RESULT_SAMPLES] == 0) TS_FAIL(TS_ERR_ORACLE, "TypeSOL: Switchboard feed has no samples");
  uint64_t clock[5] = {0};
  if (sol_get_clock_sysvar(clock) != SUCCESS) TS_FAIL(TS_ERR_SYSVAR, "TypeSOL: clock sysvar unavailable");
  uint64_t slot = (uint64_t)ts_le_i64(a->data + TS_SB_RESULT_SLOT);
  uint64_t fresh_until;
  if (__builtin_add_overflow(slot, max_stale_slots, &fresh_until)) fresh_until = UINT64_MAX;
  if (fresh_until < clock[0]) TS_FAIL(TS_ERR_ORACLE, "TypeSOL: Switchboard value is stale");
  __int128 v;
  ts_memcpy(&v, a->data + TS_SB_RESULT_VALUE, 16);
  __int128 scale = 1;
  for (int i = decimals; i < 18; i++) scale *= 10;
  __int128 r = v / scale;
  if (r > (__int128)INT64_MAX || r < (__int128)INT64_MIN) TS_FAIL(TS_ERR_OVERFLOW, "TypeSOL: oracle value does not fit in i64");
  *out = (int64_t)r;
  return SUCCESS;
}

/* ---- Associated token accounts, token metadata, transfer hooks ------------------- */
static const SolPubkey TS_ATA_PROGRAM_ID = {{140,151,37,143,78,36,137,241,187,61,16,41,20,142,13,131,11,90,19,153,218,255,16,132,4,142,123,216,219,233,248,89}};
static const SolPubkey TS_MPL_METADATA_ID = {{11,112,101,177,227,209,124,69,56,157,82,127,107,4,195,205,88,184,108,115,26,160,253,181,73,182,209,188,3,248,41,70}};

/* ATA address: PDA of [owner, token_program, mint] under the Associated Token Account program. */
static inline uint64_t ts_ata_address(const SolPubkey *owner, const SolPubkey *mint, const SolPubkey *token_program, SolPubkey *out) {
  SolSignerSeed seeds[3] = {{(const uint8_t *)owner, 32}, {(const uint8_t *)token_program, 32}, {(const uint8_t *)mint, 32}};
  uint8_t bump;
  if (ts_find_pda(seeds, 3, &TS_ATA_PROGRAM_ID, out, &bump) != SUCCESS)
    TS_FAIL(TS_ERR_SEEDS, "TypeSOL: cannot derive the associated token address");
  return SUCCESS;
}

/* Create (or, idempotent, keep) the ATA of `owner` for `mint`. Data: [] = Create, [1] = CreateIdempotent. */
static inline uint64_t ts_ata_create(TsParams *params, const TsAccount *program, TsAccount *payer, TsAccount *ata,
                                     TsAccount *owner, TsAccount *mint, TsAccount *system, TsAccount *token_program,
                                     bool idempotent) {
  uint8_t data[1] = {1};
  SolAccountMeta metas[6] = {{&payer->key, true, true},  {&ata->key, true, false},    {&owner->key, false, false},
                             {&mint->key, false, false}, {&system->key, false, false}, {&token_program->key, false, false}};
  SolInstruction ix = {(SolPubkey *)&program->key, metas, 6, data, idempotent ? 1 : 0};
  return ts_invoke(params, &ix, NULL, 0);
}

/* Append a Borsh string to a heap buffer. */
static inline void ts_put_str(uint8_t *buf, uint64_t *at, TS_Str s) {
  uint32_t n = (uint32_t)s.len;
  ts_memcpy(buf + *at, &n, 4);
  ts_memcpy(buf + *at + 4, s.ptr, s.len);
  *at += 4 + s.len;
}

/*
 * Token-2022 metadata extension (spl-token-metadata-interface Initialize) on a mint whose MetadataPointer
 * points at itself: data = sha256("spl_token_metadata_interface:initialize_account")[..8] | name | symbol | uri.
 * Accounts: metadata (the mint, writable), update authority, mint, mint authority (signer).
 */
static inline uint64_t ts_t22_init_metadata(TsParams *params, const TsAccount *program, TsAccount *mint,
                                            TsAccount *update_authority, TsAccount *mint_authority, TS_Str name,
                                            TS_Str symbol, TS_Str uri, const SolSignerSeed *seeds, int n) {
  uint8_t *data;
  TS_TRY(ts_alloc(8 + 12 + name.len + symbol.len + uri.len, &data));
  static const uint8_t disc[8] = {210, 225, 30, 162, 88, 184, 77, 141};
  ts_memcpy(data, disc, 8);
  uint64_t at = 8;
  ts_put_str(data, &at, name);
  ts_put_str(data, &at, symbol);
  ts_put_str(data, &at, uri);
  SolAccountMeta metas[4] = {{&mint->key, true, false}, {&update_authority->key, false, false}, {&mint->key, false, false}, {&mint_authority->key, false, true}};
  SolInstruction ix = {(SolPubkey *)&program->key, metas, 4, data, at};
  SolSignerSeeds signer = {seeds, (uint64_t)n};
  return ts_invoke(params, &ix, &signer, n > 0 ? 1 : 0);
}

/* Metaplex metadata PDA: ["metadata", program, mint] under Token Metadata. */
static inline uint64_t ts_metadata_address(const SolPubkey *mint, SolPubkey *out) {
  SolSignerSeed seeds[3] = {{(const uint8_t *)"metadata", 8}, {(const uint8_t *)&TS_MPL_METADATA_ID, 32}, {(const uint8_t *)mint, 32}};
  uint8_t bump;
  if (ts_find_pda(seeds, 3, &TS_MPL_METADATA_ID, out, &bump) != SUCCESS)
    TS_FAIL(TS_ERR_SEEDS, "TypeSOL: cannot derive the metadata address");
  return SUCCESS;
}

static inline uint64_t ts_master_edition_address(const SolPubkey *mint, SolPubkey *out) {
  SolSignerSeed seeds[4] = {{(const uint8_t *)"metadata", 8},
                            {(const uint8_t *)&TS_MPL_METADATA_ID, 32},
                            {(const uint8_t *)mint, 32},
                            {(const uint8_t *)"edition", 7}};
  uint8_t bump;
  if (ts_find_pda(seeds, 4, &TS_MPL_METADATA_ID, out, &bump) != SUCCESS)
    TS_FAIL(TS_ERR_SEEDS, "TypeSOL: cannot derive the master edition address");
  return SUCCESS;
}

/*
 * Metaplex CreateMetadataAccountV3 (instruction 33): DataV2 { name, symbol, uri, seller_fee_basis_points u16,
 * creators Option<Vec<Creator>>, collection Option<Collection>, uses None }, is_mutable bool, collection_details
 * None, or Some(V1 { size: 0 }) when `sized_collection`.
 * `creators` holds `ncreators` packed Creator records (address, verified, share: 34 bytes); ncreators < 0 is None.
 * `collection` (NULL for None) is written unverified, as Metaplex requires at creation.
 * Accounts: metadata (w), mint, mint authority (s), payer (ws), update authority, system program.
 */
static inline uint64_t ts_mpl_create_v3(TsParams *params, const TsAccount *program, TsAccount *metadata,
                                        TsAccount *mint, TsAccount *mint_authority, TsAccount *payer,
                                        TsAccount *update_authority, TsAccount *system, TS_Str name, TS_Str symbol,
                                        TS_Str uri, uint16_t fee_bps, bool is_mutable, const uint8_t *creators, int ncreators,
                                        const SolPubkey *collection, bool sized_collection, const SolSignerSeed *seeds, int n) {
  uint8_t *data;
  uint64_t ncr = ncreators > 0 ? (uint64_t)ncreators : 0;
  TS_TRY(ts_alloc(1 + 12 + name.len + symbol.len + uri.len + 2 + (1 + 4 + 34 * ncr) + (1 + 33) + 1 + 1 + (1 + 9), &data));
  uint64_t at = 0;
  data[at++] = 33;
  ts_put_str(data, &at, name);
  ts_put_str(data, &at, symbol);
  ts_put_str(data, &at, uri);
  ts_memcpy(data + at, &fee_bps, 2);
  at += 2;
  if (ncreators < 0) {
    data[at++] = 0; /* creators: None */
  } else {
    data[at++] = 1;
    uint32_t count = (uint32_t)ncreators;
    ts_memcpy(data + at, &count, 4);
    at += 4;
    ts_memcpy(data + at, creators, 34 * ncr);
    at += 34 * ncr;
  }
  if (collection) {
    data[at++] = 1;
    data[at++] = 0; /* verified: false */
    ts_memcpy(data + at, collection, 32);
    at += 32;
  } else {
    data[at++] = 0; /* collection: None */
  }
  data[at++] = 0; /* uses: None */
  data[at++] = is_mutable ? 1 : 0;
  if (sized_collection) {
    /* collection_details: Some(V1 { size: 0 }): this NFT is a collection items can be verified into */
    data[at++] = 1;
    data[at++] = 0;
    ts_memzero(data + at, 8);
    at += 8;
  } else {
    data[at++] = 0; /* collection_details: None */
  }
  bool ua_signs = update_authority->is_signer || ts_key_eq(&update_authority->key, &mint_authority->key);
  SolAccountMeta metas[6] = {{&metadata->key, true, false},          {&mint->key, false, false},
                             {&mint_authority->key, false, true},     {&payer->key, true, true},
                             {&update_authority->key, false, ua_signs}, {&system->key, false, false}};
  SolInstruction ix = {(SolPubkey *)&program->key, metas, 6, data, at};
  SolSignerSeeds signer = {seeds, (uint64_t)n};
  return ts_invoke(params, &ix, &signer, n > 0 ? 1 : 0);
}

/*
 * Transfer hook validation account (ExtraAccountMetaList with no extra accounts) at PDA
 * ["extra-account-metas", mint]: TLV = execute discriminator | u32 length 4 | u32 count 0.
 */
static const uint8_t TS_TRANSFER_HOOK_EXECUTE_DISC[8] = {105, 37, 101, 197, 75, 251, 102, 26};
/*
 * The ExtraAccountMetaList (spl-tlv-account-resolution) at PDA ["extra-account-metas", mint]: the execute
 * discriminator, a u32 length, then a PodSlice of `n` 35-byte ExtraAccountMeta records (discriminator, 32-byte address
 * or packed seeds, is_signer, is_writable), which the compiler encodes into `entries`.
 */
static inline uint64_t ts_init_extra_metas(TsParams *params, TsAccount *payer, TsAccount *acct, const SolPubkey *mint, const uint8_t *entries,
                                           uint32_t n) {
  SolSignerSeed seeds[3] = {{(const uint8_t *)"extra-account-metas", 19}, {(const uint8_t *)mint, 32}};
  uint8_t bump;
  uint64_t space = 16 + 35 * (uint64_t)n;
  TS_TRY(ts_create_pda(params, payer, acct, seeds, 2, TS_TRANSFER_HOOK_EXECUTE_DISC, space, &bump));
  uint32_t len = 4 + 35 * n;
  ts_memcpy(acct->data + 8, &len, 4);
  ts_memcpy(acct->data + 12, &n, 4);
  if (n) ts_memcpy(acct->data + 16, entries, 35 * (uint64_t)n);
  return SUCCESS;
}

/*
 * ExtraAccountMetaList::update: rewrite an existing list (this program's PDA ["extra-account-metas", mint], holding the
 * execute discriminator), resizing it to `n` records. The payer tops it up to the rent of the new size when its
 * lamports fall short, as the program-examples do before `resize`.
 */
static inline uint64_t ts_update_extra_metas(TsParams *params, TsAccount *payer, TsAccount *acct, const SolPubkey *mint, const uint8_t *entries,
                                             uint32_t n) {
  SolSignerSeed seeds[2] = {{(const uint8_t *)"extra-account-metas", 19}, {(const uint8_t *)mint, 32}};
  SolPubkey pda;
  uint8_t bump;
  if (ts_find_pda(seeds, 2, params->program_id, &pda, &bump) != SUCCESS || !ts_key_eq(&pda, &acct->key))
    TS_FAIL(TS_ERR_SEEDS, "TypeSOL: not the mint's extra-account-metas PDA");
  if (!ts_key_eq(&acct->owner, params->program_id)) TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: the extra-account-metas account is not this program's");
  if (acct->data_len < 16 || ts_ld64(acct->data) != ts_ld64(TS_TRANSFER_HOOK_EXECUTE_DISC))
    TS_FAIL(TS_ERR_DISCRIMINATOR, "TypeSOL: not an ExtraAccountMetaList");
  uint64_t new_len = 16 + 35 * (uint64_t)n;
  uint64_t rent;
  TS_TRY(ts_minimum_balance(new_len, &rent));
  if (rent > acct->lamports) TS_TRY(ts_system_transfer(params, payer, acct, rent - acct->lamports));
  if (new_len > acct->data_len + MAX_PERMITTED_DATA_INCREASE) TS_FAIL(TS_ERR_REALLOC, "TypeSOL: account would grow more than 10 KiB in one instruction");
  if (new_len > acct->data_len) ts_memzero(acct->data + acct->data_len, new_len - acct->data_len);
  acct->data_len = new_len;
  uint32_t len = 4 + 35 * n;
  ts_memcpy(acct->data + 8, &len, 4);
  ts_memcpy(acct->data + 12, &n, 4);
  if (n) ts_memcpy(acct->data + 16, entries, 35 * (uint64_t)n);
  return SUCCESS;
}

