/**
 * Rewrites one JavaScript cell into a classic script whose top-level bindings survive into the next
 * cell, like a REPL.
 *
 * The approach follows oh-my-pi's `eval` tool (packages/coding-agent/src/eval/js/shared/rewrite-imports.ts,
 * MIT License, see NOTICE): top-level `const`/`let`/`class` become `var`, static imports become
 * dynamic imports, and a cell with top-level `await` runs inside an async function whose bindings
 * are declared as globals.
 */
import { parse } from "acorn";

type Node = { type: string; start: number; end: number; [key: string]: any };
type Edit = { start: number; end: number; text: string };

export interface RewrittenCell {
	/** Classic script source for `vm.runInThisContext`. */
	script: string;
	/** The script evaluates to a promise of the cell value. */
	isAsync: boolean;
}

/** Name of the global that resolves module specifiers against the working directory. */
export const IMPORT_HELPER = "__pi_import";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

export function rewriteCell(code: string): RewrittenCell {
	const program = parse(code, {
		ecmaVersion: "latest",
		sourceType: "module",
		allowAwaitOutsideFunction: true,
		allowHashBang: true,
	}) as unknown as Node;
	const body: Node[] = program.body;
	const isAsync = body.some(isImport) || containsTopLevelAwait(program);
	return { script: isAsync ? asyncScript(code, body) : syncScript(code, body), isAsync };
}

function isImport(node: Node): boolean {
	return node.type === "ImportDeclaration";
}

/** Whether `await` (or `for await`) appears outside every function body. */
function containsTopLevelAwait(node: unknown): boolean {
	return isAwait(node) || sameScopeChildren(node).some(containsTopLevelAwait);
}

function isAstObject(value: unknown): value is Node {
	return typeof value === "object" && value !== null;
}

function isAwait(value: unknown): boolean {
	if (!isAstObject(value)) return false;
	return value.type === "AwaitExpression" || value.await === true;
}

/** Child values that share the top-level scope: function bodies start their own. */
function sameScopeChildren(value: unknown): unknown[] {
	return isAstObject(value) && !FUNCTION_TYPES.has(value.type) ? Object.values(value) : [];
}

// ---------------------------------------------------------------- sync cells

function syncScript(code: string, body: Node[]): string {
	return applyEdits(code, body.flatMap(syncEdits));
}

function syncEdits(node: Node): Edit[] {
	return [...exportKeywordEdits(node), ...demote(unwrapExport(node))];
}

/** `const`/`let` → `var`; `class C {}` → `var C = class C {};`. */
function demote(node: Node): Edit[] {
	if (node.type === "VariableDeclaration") return [keywordEdit(node, "var")];
	if (node.type !== "ClassDeclaration") return [];
	return [
		{ start: node.start, end: node.start, text: `var ${node.id.name} = ` },
		{ start: node.end, end: node.end, text: ";" },
	];
}

function keywordEdit(node: Node, text: string): Edit {
	return { start: node.start, end: node.start + node.kind.length, text };
}

function unwrapExport(node: Node): Node {
	return node.type === "ExportNamedDeclaration" && node.declaration ? node.declaration : node;
}

/** Removes the `export` keyword: a cell is a script, not a module. */
function exportKeywordEdits(node: Node): Edit[] {
	const declaration = unwrapExport(node);
	return declaration === node ? [] : [{ start: node.start, end: declaration.start, text: "" }];
}

// ---------------------------------------------------------------- async cells

function asyncScript(code: string, body: Node[]): string {
	const scope: AsyncScope = { code, names: new Set(), functionNames: [] };
	const { names, functionNames } = scope;
	const edits = body.flatMap((node) => [...exportKeywordEdits(node), ...asyncEdits(unwrapExport(node), scope)]);
	const last = body.at(-1);
	if (last?.type === "ExpressionStatement") edits.push(...returnEdits(last));
	const inner = applyEdits(code, edits);
	const declared = names.size > 0 ? `var ${[...names].join(", ")};\n` : "";
	const publish = functionNames.map((name) => `globalThis.${name} = ${name};`).join(" ");
	return `${declared}(async () => { ${publish}\n${inner}\n})()`;
}

/** Bindings an async cell declares as globals; functions are also published from inside the wrapper. */
interface AsyncScope {
	code: string;
	names: Set<string>;
	functionNames: string[];
}

const ASYNC_EDITS: Record<string, (node: Node, scope: AsyncScope) => Edit[]> = {
	ImportDeclaration: (node, scope) => [importEdit(node, scope.names)],
	VariableDeclaration: (node, scope) => [assignmentEdit(scope.code, node, scope.names)],
	ClassDeclaration: (node, scope) => classAssignment(node, scope.names),
	FunctionDeclaration: (node, scope) => publishFunction(node, scope),
};

function asyncEdits(node: Node, scope: AsyncScope): Edit[] {
	const edits = ASYNC_EDITS[node.type];
	return edits ? edits(node, scope) : [];
}

function publishFunction(node: Node, scope: AsyncScope): Edit[] {
	scope.names.add(node.id.name);
	scope.functionNames.push(node.id.name);
	return [];
}

/** `import d, { a as b } from "m"` → `({ default: d, a: b } = await __pi_import("m"));` */
function importEdit(node: Node, names: Set<string>): Edit {
	const source = JSON.stringify(node.source.value);
	const loader = `await ${IMPORT_HELPER}(${source})`;
	const parts = node.specifiers.map((specifier: Node) => importPart(specifier, names));
	const namespace = parts.find((part: string) => part.startsWith("*"));
	const text = namespace ? `${namespace.slice(1)} = ${loader};` : `({ ${parts.join(", ")} } = ${loader});`;
	return { start: node.start, end: node.end, text };
}

function importPart(specifier: Node, names: Set<string>): string {
	const local = specifier.local.name;
	names.add(local);
	const kinds: Record<string, string> = {
		ImportDefaultSpecifier: `default: ${local}`,
		ImportNamespaceSpecifier: `*${local}`,
	};
	return kinds[specifier.type] ?? `${importedName(specifier)}: ${local}`;
}

function importedName(specifier: Node): string {
	const imported = specifier.imported;
	return imported.type === "Literal" ? JSON.stringify(imported.value) : imported.name;
}

/** `const { a } = o, b = 1;` → `({ a } = o), (b = 1);` with `a`, `b` declared as globals. */
function assignmentEdit(code: string, node: Node, names: Set<string>): Edit {
	const assignments = node.declarations.map((declarator: Node) => {
		collectPatternNames(declarator.id, names);
		const target = code.slice(declarator.id.start, declarator.id.end);
		const value = declarator.init ? code.slice(declarator.init.start, declarator.init.end) : "void 0";
		return `(${target} = ${value})`;
	});
	return { start: node.start, end: node.end, text: `${assignments.join(", ")};` };
}

function classAssignment(node: Node, names: Set<string>): Edit[] {
	names.add(node.id.name);
	return [
		{ start: node.start, end: node.start, text: `${node.id.name} = ` },
		{ start: node.end, end: node.end, text: ";" },
	];
}

function returnEdits(statement: Node): Edit[] {
	return [
		{ start: statement.start, end: statement.start, text: "return (" },
		{ start: statement.expression.end, end: statement.end, text: ");" },
	];
}

const PATTERN_CHILDREN: Record<string, (node: Node) => Node[]> = {
	ObjectPattern: (node) => node.properties.map((property: Node) => property.value ?? property.argument),
	ArrayPattern: (node) => node.elements.filter(Boolean),
	RestElement: (node) => [node.argument],
	AssignmentPattern: (node) => [node.left],
};

function collectPatternNames(pattern: Node, names: Set<string>): void {
	if (pattern.type === "Identifier") names.add(pattern.name);
	for (const child of PATTERN_CHILDREN[pattern.type]?.(pattern) ?? []) collectPatternNames(child, names);
}

// ---------------------------------------------------------------- edits

function applyEdits(code: string, edits: Edit[]): string {
	const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
	return ordered.reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), code);
}
