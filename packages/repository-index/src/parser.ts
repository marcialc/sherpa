import ts from "typescript";
import { parsedFileSchema, sourceFileSchema, type ParsedFile, type SourceFile } from "./types";

const supported = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const noiseDirectory =
  /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|generated|__generated__|\.git|\.next|\.wrangler|\.turbo)(?:\/|$)/i;
const noiseFile =
  /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:min|generated|gen)\.[^/]+|(?:package-lock|yarn\.lock|pnpm-lock).*)$/i;
const sensitivePath = /(?:^|\/)(?:secrets?|credentials?|private[-_]?keys?)(?:[./_-]|$)/i;

/** Exclusions accept exact paths, directory prefixes and simple *, ** and ? globs. */
function excluded(path: string, pattern: string): boolean {
  const normalized = pattern.replace(/^\.\//, "").replace(/^\//, "").replace(/\/$/, "");
  if (!normalized) return false;
  if (!/[?*]/.test(normalized)) return path === normalized || path.startsWith(`${normalized}/`);
  let expression = "";
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index++;
      }
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[\\^$+?.()|{}[\]]/g, "\\$&");
  }
  return new RegExp(`^${expression}(?:/.*)?$`).test(path);
}

export function shouldIndexFile(
  file: SourceFile,
  config: { maxFileBytes: number; excludePaths: string[] },
): boolean {
  return (
    sourceFileSchema.safeParse(file).success &&
    supported.test(file.path) &&
    file.size <= config.maxFileBytes &&
    !noiseDirectory.test(file.path) &&
    !noiseFile.test(file.path) &&
    !sensitivePath.test(file.path) &&
    !config.excludePaths.some((pattern) => excluded(file.path, pattern))
  );
}

export function isGeneratedSource(source: string): boolean {
  return /@generated\b|auto[- ]generated|generated (?:file|code)|do not edit/i.test(
    source.slice(0, 2048),
  );
}

/** Never collects comments, initializer values, computed names or string property names. */
export function parseSource(file: SourceFile, source: string): ParsedFile {
  try {
    return parseMetadata(file, source);
  } catch {
    // Adversarial nesting can exhaust the parser or traversal stack. Keep the index build usable.
    return {
      language: /\.[cm]?tsx?$/i.test(file.path) ? "typescript" : "javascript",
      symbols: [],
      imports: [],
      exports: [],
      parseIncomplete: true,
    };
  }
}

function parseMetadata(file: SourceFile, source: string): ParsedFile {
  const language = /\.[cm]?tsx?$/i.test(file.path) ? "typescript" : "javascript";
  const ast = ts.createSourceFile(file.path, source, ts.ScriptTarget.Latest, true);
  const symbols: ParsedFile["symbols"] = [];
  const imports = new Set<string>();
  const exports = new Set<string>();
  const exportedLocals = new Set<string>();
  // TypeScript exposes parser diagnostics at runtime but omits them from the public interface.
  let incomplete =
    Boolean(
      (ast as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics
        ?.length,
    ) ||
    source.includes("\0") ||
    !supported.test(file.path);
  const addString = (target: Set<string>, value: string, count: number, length: number) => {
    if (value.length > length || target.size >= count) {
      incomplete = true;
      return;
    }
    target.add(value);
  };
  const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
    ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((item) => item.kind === kind));
  const addSymbol = (
    node: ts.Node,
    name: string,
    kind: ParsedFile["symbols"][number]["kind"],
    exported: boolean,
  ) => {
    if (!name || name.length > 200 || symbols.length >= 200) {
      incomplete = true;
      return;
    }
    symbols.push({
      name,
      kind,
      startLine: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      endLine:
        ast.getLineAndCharacterOfPosition(Math.max(node.getStart(ast), node.end - 1)).line + 1,
      exported,
    });
    if (exported && kind !== "method") addString(exports, name, 200, 200);
  };
  const moduleImport = (value: string) => {
    // Module specifiers are untrusted strings too; exclude URLs, controls and credential-like values.
    if (/^(?:node:)?[a-zA-Z0-9@_./~-]+$/.test(value)) addString(imports, value, 100, 300);
  };
  const visit = (node: ts.Node, owner = "", inheritedExport = false): void => {
    const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword) || inheritedExport;
    const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
    if (isDefault) addString(exports, "default", 200, 200);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      moduleImport(node.moduleSpecifier.text);
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    )
      moduleImport(node.moduleReference.expression.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      moduleImport(node.arguments[0].text);
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        moduleImport(node.moduleSpecifier.text);
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const item of node.exportClause.elements) {
          if (!ts.isIdentifier(item.name)) continue;
          addString(exports, item.name.text, 200, 200);
          if (!node.moduleSpecifier) exportedLocals.add(item.propertyName?.text ?? item.name.text);
        }
      } else if (node.exportClause && ts.isNamespaceExport(node.exportClause))
        addString(exports, node.exportClause.name.text, 200, 200);
      else addString(exports, "*", 200, 200);
    }
    if (ts.isExportAssignment(node)) {
      addString(exports, node.isExportEquals ? "export=" : "default", 200, 200);
      if (ts.isIdentifier(node.expression)) exportedLocals.add(node.expression.text);
      if (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression))
        addSymbol(node.expression, "default", "function", true);
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const name = node.name?.text ?? (isDefault ? "default" : owner);
      if (name) addSymbol(node, name, "class", exported);
      ts.forEachChild(node, (child) => visit(child, name, exported));
      return;
    }
    if (ts.isFunctionDeclaration(node))
      addSymbol(node, node.name?.text ?? "default", "function", exported);
    if (ts.isInterfaceDeclaration(node)) {
      addSymbol(node, node.name.text, "interface", exported);
      ts.forEachChild(node, (child) => visit(child, node.name.text, exported));
      return;
    }
    if (ts.isTypeAliasDeclaration(node)) addSymbol(node, node.name.text, "type", exported);
    if (ts.isEnumDeclaration(node)) addSymbol(node, node.name.text, "enum", exported);
    if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name))
      addSymbol(node, node.name.text, "namespace", exported);
    if (
      (ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        (ts.isPropertyDeclaration(node) &&
          node.initializer &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))) &&
      ts.isIdentifier(node.name)
    )
      addSymbol(
        node,
        owner ? `${owner}.${node.name.text}` : node.name.text,
        "method",
        exported && !hasModifier(node, ts.SyntaxKind.PrivateKeyword),
      );
    if (ts.isVariableStatement(node)) {
      const constant = Boolean(node.declarationList.flags & ts.NodeFlags.Const);
      const collectBinding = (
        binding: ts.BindingName,
        declaration: ts.VariableDeclaration,
      ): void => {
        if (ts.isIdentifier(binding)) {
          const callable =
            declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) ||
              ts.isFunctionExpression(declaration.initializer));
          addSymbol(
            declaration,
            binding.text,
            callable ? "function" : constant ? "constant" : "variable",
            exported,
          );
        } else
          for (const item of binding.elements)
            if (ts.isBindingElement(item)) collectBinding(item.name, declaration);
      };
      for (const declaration of node.declarationList.declarations)
        collectBinding(declaration.name, declaration);
    }
    // Export status belongs to declarations and class members, never nested function locals.
    ts.forEachChild(node, (child) => visit(child, owner, false));
  };
  visit(ast);
  for (const symbol of symbols) if (exportedLocals.has(symbol.name)) symbol.exported = true;
  return parsedFileSchema.parse({
    language,
    symbols,
    imports: [...imports],
    exports: [...exports],
    parseIncomplete: incomplete,
  });
}
