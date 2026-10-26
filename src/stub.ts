/**
 * `import ... from "typesol"` in TypeSol programs is for the compiler and the type checker: the declarations live in
 * lib/typesol.d.ts and the code is compiled to SBF by `typesol build`. Running it under Node is a mistake.
 */
throw new Error('"typesol" programs are compiled to Solana SBF with `typesol build`; they do not run in Node.js.');
export {};
