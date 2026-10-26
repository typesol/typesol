// String literals with non-ASCII bytes followed by hex-digit characters must survive C escaping.
import { type u64, byteLength } from "typesol";

export function check(s: string): u64 {
  if (s === "éa café\u0001b ?? ") return byteLength("éa café\u0001b ?? ");
  return 0n;
}
