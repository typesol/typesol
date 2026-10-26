import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_DIR = fileURLToPath(new URL("../../runtime/", import.meta.url));

/** SBPF versions the C SDK targets: v0 (default, every cluster), v1 and v2 (where the feature gates are active). */
export type Sbpf = "v0" | "v1" | "v2";

/** Executable names: platform-tools ship .exe files on Windows. */
const EXE = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);
export const SBPF_VERSIONS: readonly Sbpf[] = ["v0", "v1", "v2"];

export interface Toolchain {
  sdk: string;
  clang: string;
  lld: string;
  linkerScript: string;
  includes: string[];
  libDir: string;
  compilerBuiltins: string;
}

/** Locate the Solana C SDK that ships with the Agave CLI's platform-tools. */
export function findToolchain(sbpf: Sbpf = "v0"): Toolchain {
  // Where the Agave installer puts it, or next to `cargo-build-sbf` on PATH (custom --data-dir, Homebrew, Docker…).
  const onPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) => [path.join(dir, "platform-tools-sdk/sbf"), path.join(dir, "sdk/sbf")])
    .filter((p) => existsSync(path.join(path.dirname(path.dirname(p)), EXE("cargo-build-sbf"))));
  const override = process.env.TYPESOL_SBF_SDK;
  if (override && !existsSync(path.join(override, "c/sbf.mk")))
    throw new Error(`TYPESOL_SBF_SDK=${override} is not a platform-tools-sdk/sbf directory (no c/sbf.mk there)`);
  const candidates = [
    override,
    path.join(os.homedir(), ".local/share/solana/install/active_release/bin/platform-tools-sdk/sbf"),
    path.join(os.homedir(), ".local/share/solana/install/active_release/bin/sdk/sbf"),
    ...onPath,
  ].filter((p): p is string => !!p);
  const sdk = candidates.find((p) => existsSync(path.join(p, "c/sbf.mk")));
  if (!sdk)
    throw new Error(
      "Solana SBF SDK not found. Install the Agave CLI (https://docs.anza.xyz/cli/install) and run `cargo-build-sbf --version` once, or set TYPESOL_SBF_SDK to its platform-tools-sdk/sbf directory.",
    );
  const llvm = path.join(sdk, "dependencies/platform-tools/llvm");
  const clang = path.join(llvm, "bin", EXE("clang"));
  if (!existsSync(clang)) throw new Error(`platform-tools missing under ${sdk}/dependencies. Run \`cargo-build-sbf --force-tools-install\` once.`);
  // Newest clang resource directory (numeric order: "9" < "19").
  const clangInc = readdirSync(path.join(llvm, "lib/clang"))
    .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b))
    .at(-1)!;
  const target = sbpf === "v0" ? "sbpf" : `sbpf${sbpf}`;
  const rustlib = path.join(sdk, `dependencies/platform-tools/rust/lib/rustlib/${target}-solana-solana/lib`);
  const builtins = existsSync(rustlib) ? readdirSync(rustlib).find((f) => f.startsWith("libcompiler_builtins-") && f.endsWith(".rlib")) : undefined;
  if (!builtins)
    throw new Error(
      `these platform-tools have no SBPF ${sbpf} libraries (${rustlib}). Update them with \`cargo-build-sbf --force-tools-install\`, or build for another --sbpf.`,
    );
  return {
    sdk,
    clang,
    lld: path.join(llvm, "bin", EXE("ld.lld")),
    linkerScript: path.join(sdk, "c/sbf.ld"),
    includes: [path.join(sdk, "c/inc"), path.join(llvm, "lib/clang", clangInc, "include"), path.join(llvm, `${target}/include`), RUNTIME_DIR],
    libDir: path.join(llvm, `lib/${target}`),
    compilerBuiltins: path.join(rustlib, builtins),
  };
}

/** Compile generated C to an SBF shared object (same flags as the SDK's sbf.mk for the chosen SBPF version). */
export function buildSharedObject(cFile: string, outSo: string, sbpf: Sbpf = "v0", tc = findToolchain(sbpf)): void {
  const obj = outSo.replace(/\.so$/, ".o");
  const cflags = [
    "-Werror",
    "-Wno-parentheses-equality",
    // Generated checks may be always true/false (`a === a`, `enumByte >= 256` for a 256-variant enum); that is not an error.
    "-Wno-tautological-compare",
    "-O2",
    "-fno-builtin",
    "-std=c17",
    "-target",
    "sbf",
    "-fPIC",
    ...(sbpf === "v0" ? [] : [`-mcpu=${sbpf}`]),
  ];
  const incs = tc.includes.flatMap((i, n) => (n < 2 ? ["-isystem", i] : ["-I", i]));
  run(tc.clang, [...cflags, ...incs, "-o", obj, "-c", cFile]);
  run(tc.lld, [
    "-z",
    "notext",
    "-shared",
    "--Bdynamic",
    tc.linkerScript,
    "--entry",
    "entrypoint",
    "-L",
    tc.libDir,
    "-z",
    "max-page-size=4096",
    "-lc",
    "-o",
    outSo,
    obj,
    tc.compilerBuiltins,
  ]);
  rmSync(obj, { force: true }); // the object file is only an intermediate
}

/** The clang version string, for build manifests. */
export function toolchainVersion(tc = findToolchain()): string {
  return execFileSync(tc.clang, ["--version"], { encoding: "utf8" }).split("\n")[0].trim();
}

function run(cmd: string, args: string[]) {
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    throw new Error(`${path.basename(cmd)} failed:\n${err.stderr?.toString() ?? ""}${err.stdout?.toString() ?? ""}`);
  }
}
