import ts from "typescript";

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
}

export class CompileError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join("\n"));
    this.name = "CompileError";
  }
}

export function formatDiagnostic(d: Diagnostic): string {
  return `${d.file}:${d.line}:${d.column} - error: ${d.message}`;
}

export function diagnosticAt(node: ts.Node, message: string): Diagnostic {
  const sf = node.getSourceFile();
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { file: sf.fileName, line: line + 1, column: character + 1, message };
}

/** Collects diagnostics; `fail` records one and throws to unwind the current construct. */
export class Reporter {
  readonly diagnostics: Diagnostic[] = [];

  error(node: ts.Node, message: string): void {
    this.diagnostics.push(diagnosticAt(node, message));
  }

  fail(node: ts.Node, message: string): never {
    this.error(node, message);
    throw new Bail();
  }

  /** Run `fn`, swallowing a `fail` so analysis can continue with the next construct. */
  guard<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      if (e instanceof Bail) return undefined;
      throw e;
    }
  }

  throwIfAny(): void {
    if (this.diagnostics.length > 0) throw new CompileError(this.diagnostics);
  }
}

class Bail extends Error {}
