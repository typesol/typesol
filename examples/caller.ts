import { type AccountInfo, type Program, type u64, invoke, log, readonly, require, returnData, sighash } from "typesol";

/**
 * Reads another program's return data after a CPI.
 * The address below is where examples/profiles.ts is deployed; change it to your own deployment.
 */
export function checkDistance(profile: AccountInfo, profiles: Program<"rkaKbBvstspt8GdG4uwY5MzjNXxsfvqdKmYQRFpfwM6">, atLeast: u64): u64 {
  invoke(profiles, [readonly(profile)], [sighash("distance")]);
  const walked = returnData<u64>(profiles);
  log(walked);
  require(walked >= atLeast, "not far enough");
  return walked * 2n;
}
