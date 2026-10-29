import ts from "typescript";
import { type FieldType, isWritable } from "../model.js";
import { EmitterBase } from "./base.js";

/**
 * Aliasing, in one place. A struct read from account data is a reference into that data, not a copy, so code that
 * replaces or moves the data under a reference still in use would let it read a value JS would not show. The rules:
 *
 * - `pathsOf` names the storage an expression refers to (`acct.a.b`, `v[]` for a Vec element, a reference local's
 *   paths); every reference local records its paths when it is declared (statements.ts).
 * - `assertNotAliased(paths, at)` refuses replacing a place while a reference into it is read later (`usedAfter`).
 *   Called for: assigning a struct or list (statements.ts `assign`); `set` of a struct element of an array or Vec,
 *   `pop` and `clear` (calls.ts); any push / pop / clear that moves the growable Vecs stored after the one it resizes
 *   (calls.ts `tailStart`); a helper taking a writable struct account (calls.ts); `acct.migrate(…)` (calls.ts).
 * - `mayResizeVecs(node)` decides whether evaluating a value may resize a growable Vec (moving the Vecs after it); an
 *   assignment whose target is reached through a Vec element (`writesThroughVec`) is then refused (statements.ts).
 *
 * Accounts passed twice are a separate rule: function.ts refuses two writable parameters naming one account (2040)
 * unless `Dup<…>` allows it for in-place accounts.
 */
export abstract class AliasEmitter extends EmitterBase {
  protected abstract peekKind(node: ts.Expression): FieldType["kind"] | undefined;

  /**
   * Storage paths an expression names, syntactically: `acct.a.b` -> ["acct.a.b"], `v.get(i)` -> ["v[]"],
   * a reference local -> the paths it aliases, a ternary -> both sides. Undefined when unknown.
   */
  protected pathsOf(node: ts.Expression): string[] | undefined {
    if (ts.isParenthesizedExpression(node)) return this.pathsOf(node.expression);
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      if (l) return l.paths ?? (l.type.kind === "array" ? [`@${l.c}`] : undefined);
      return this.accounts.has(node.text) ? [node.text] : undefined;
    }
    if (ts.isPropertyAccessExpression(node)) return this.pathsOf(node.expression)?.map((p) => `${p}.${node.name.text}`);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "get")
      return this.pathsOf(node.expression.expression)?.map((p) => `${p}[]`);
    if (ts.isConditionalExpression(node)) {
      const a = this.pathsOf(node.whenTrue);
      const b = this.pathsOf(node.whenFalse);
      return a && b ? [...a, ...b] : undefined;
    }
    return undefined;
  }

  /**
   * In JS, replacing an object (`acct.pos = {...}`, `v.set(i, {...})`, `v.pop()`) leaves earlier references
   * to the old object unchanged. Here a reference is a pointer into account data, so it would see the new
   * value. Refuse when a live reference into the replaced place is still used afterwards.
   */
  protected assertNotAliased(replaced: string[] | undefined, at: ts.Node, helper?: string) {
    if (!replaced) return;
    for (const scope of this.scopes)
      for (const [name, l] of scope) {
        if (!l.paths || !l.decl) continue;
        const hit = replaced.find((r) => l.paths!.some((p) => p === r || p.startsWith(`${r}.`) || p.startsWith(`${r}[]`)));
        if (!hit || !this.usedAfter(l.decl, at)) continue;
        this.fail(
          at,
          helper
            ? `"${name}" still refers to data in ${hit}, and ${helper}() may replace it (then "${name}" would read the new value; in JS it keeps the old one). Copy the fields you need into locals first`
            : `"${name}" still refers to ${hit}; replacing it here would change what "${name}" reads (in JS it keeps the old value). Copy the fields you need into locals first`,
        );
      }
  }

  /**
   * Whether the variable declared by `decl` is read after `at` (later in its block, or anywhere in a loop around `at`).
   * A parameter (of a closure or helper expanded here) is read after `at` when its function reads it after `at`; when
   * `at` is in another function (a closure or helper it calls), any read of it in its own function counts.
   */
  protected usedAfter(decl: ts.VariableDeclaration | ts.ParameterDeclaration, at: ts.Node): boolean {
    const symbol = this.checker.getSymbolAtLocation(decl.name);
    if (!symbol) return true;
    if (ts.isParameter(decl)) {
      const fn = decl.parent;
      const inside = at.getSourceFile() === fn.getSourceFile() && at.pos >= fn.pos && at.end <= fn.end;
      let read = false;
      const visitParam = (n: ts.Node) => {
        if (read) return;
        if (ts.isIdentifier(n) && n !== decl.name && this.checker.getSymbolAtLocation(n) === symbol) {
          if (!inside || n.pos >= at.end) read = true;
          // A loop inside the function, around `at`, reads it again on its next turn.
          for (let p: ts.Node | undefined = at.parent; inside && p && p !== fn; p = p.parent)
            if ((ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && n.pos >= p.pos && n.end <= p.end)
              read = true;
        }
        ts.forEachChild(n, visitParam);
      };
      const body = (fn as { body?: ts.Node }).body;
      if (body) visitParam(body);
      return read;
    }
    // Loops around `at` that do not also contain the declaration run their earlier statements again later.
    let loop: ts.Node | undefined;
    for (let n: ts.Node | undefined = at.parent; n && n !== decl.parent; n = n.parent)
      if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) && !(decl.pos >= n.pos && decl.end <= n.end))
        loop = n;
    let found = false;
    const scope = decl.parent.parent.parent; // VariableDeclaration -> List -> Statement -> enclosing block
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(n) && n !== decl.name && this.checker.getSymbolAtLocation(n) === symbol) {
        if (n.pos >= at.end || (loop && n.pos >= loop.pos && n.end <= loop.end)) found = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return found;
  }

  /** Whether a place goes through a Vec element (`v.get(i).x`, `v.get(i)`). */
  protected writesThroughVec(node: ts.Expression): boolean {
    for (let n: ts.Expression = node; ;) {
      if (ts.isParenthesizedExpression(n)) n = n.expression;
      else if (ts.isPropertyAccessExpression(n)) n = n.expression;
      else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "get") {
        if (this.peekKind(n.expression.expression) === "vec") return true;
        n = n.expression.expression;
      } else return false;
    }
  }

  protected helperTakesMutAccounts(node: ts.CallExpression): boolean {
    const h = this.helperOf(node);
    return !!h?.params.some((p) => p.account && isWritable(p.account));
  }

  /**
   * Whether evaluating `node` may resize a growable Vec (and so move the Vecs after it): a push / pop / clear, a
   * realloc or close, a helper taking a writable account or a function argument, or a closure (its body is not
   * looked into: it may capture the account). Conservative: it only decides whether a Vec element may be the target.
   */
  protected mayResizeVecs(node: ts.Node): boolean {
    let found = false;
    const isClosure = (e: ts.Expression) => ts.isArrowFunction(e) || ts.isFunctionExpression(e) || (ts.isIdentifier(e) && !!this.lookup(e.text)?.closure);
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (ts.isPropertyAccessExpression(callee) && ["push", "pop", "clear"].includes(callee.name.text)) found = true;
        else if (ts.isCallExpression(callee))
          found = true; // a function a function returns
        else if (ts.isIdentifier(callee)) {
          if (this.lookup(callee.text)?.closure) found = true;
          else if (["realloc", "close"].includes(this.exportName(callee) ?? "")) found = true;
          else if (this.helperOf(n) && (this.helperTakesMutAccounts(n) || n.arguments.some(isClosure))) found = true;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  }
}
