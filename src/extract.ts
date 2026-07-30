import type {
	ArithmeticExpression,
	AssignmentPrefix,
	Command,
	CommandExpansionPart,
	Node,
	ParameterExpansionPart,
	ProcessSubstitutionPart,
	Redirect,
	Script,
	TestExpression,
	Word,
	WordPart,
} from "unbash";
import { parse as parseBash } from "unbash";
import type { CommandRef } from "./types.ts";

// This module walks the entire bash AST because a permission guard must see
// every command that the shell will actually execute. Commands can be hidden
// inside command substitutions ($(...)), process substitutions (<(...)),
// backticks, heredoc bodies, arithmetic expansions, and various control-flow
// constructs. Being exhaustive here is intentional; missing a nested command
// would create a bypass.

export type { CommandRef };

/** Mutable context for tracking group IDs during extraction. */
export interface ExtractCtx {
	nextGroupId: number;
	groupParents: Map<number, number | undefined>;
}

/** Create a new extraction context starting at groupId 0. */
export function createExtractCtx(): ExtractCtx {
	return { nextGroupId: 0, groupParents: new Map() };
}

/** Allocate the next group ID from the context. */
function allocGroupId(ctx: ExtractCtx, parentGroup?: number): number {
	const groupId = ctx.nextGroupId++;
	ctx.groupParents.set(groupId, parentGroup);
	return groupId;
}

/** Find the last CommandRef in commands that has the given group,
 *  searching from startIdx onward. Returns undefined if none found.
 *  This is used to assign joiners to the correct command when recursive
 *  extraction (e.g. subshells) has added commands from different groups. */
function findLastInGroup(
	commands: CommandRef[],
	groupId: number,
	startIdx: number,
): CommandRef | undefined {
	for (let i = commands.length - 1; i >= startIdx; i--) {
		if (commands[i]?.group === groupId) {
			return commands[i];
		}
	}
	return undefined;
}

export function extractAllCommandsFromAST(
	node: Script | Node,
	source: string,
	ctx?: ExtractCtx,
): CommandRef[] {
	const ownCtx = ctx ?? createExtractCtx();
	const topGroup = allocGroupId(ownCtx);
	const commands: CommandRef[] = [];
	collectNode(node, source, commands, topGroup, ownCtx);
	return commands;
}

function collectNode(
	node: Script | Node | undefined,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (!node) return;
	const t = node.type;
	if (
		t === "Script" ||
		t === "CompoundList" ||
		t === "Pipeline" ||
		t === "AndOr"
	) {
		collectCompoundOrChain(node, source, commands, groupId, ctx);
		return;
	}
	if (
		t === "If" ||
		t === "While" ||
		t === "For" ||
		t === "Select" ||
		t === "Case"
	) {
		collectControlFlow(node, source, commands, groupId, ctx);
		return;
	}
	collectRemaining(node, source, commands, groupId, ctx);
}

/** Handle Script, CompoundList, Pipeline, and AndOr node types. */
function collectCompoundOrChain(
	node: Script | Node,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	switch (node.type) {
		case "Script":
		case "CompoundList": {
			for (const [i, child] of node.commands.entries()) {
				const startIdx = commands.length;
				collectNode(child, source, commands, groupId, ctx);
				const joinerTarget = findLastInGroup(commands, groupId, startIdx);
				if (i < node.commands.length - 1 && joinerTarget) {
					joinerTarget.joiner = ";";
				}
			}
			return;
		}
		case "Pipeline":
		case "AndOr": {
			for (const [i, child] of node.commands.entries()) {
				const startIdx = commands.length;
				collectNode(child, source, commands, groupId, ctx);
				const joinerTarget = findLastInGroup(commands, groupId, startIdx);
				const op = node.operators[i];
				if (op !== undefined && joinerTarget) {
					joinerTarget.joiner = op as "|" | "&&" | "||";
				}
			}
			return;
		}
	}
}

/** Handle If, While, For, Select, and Case node types. */
function collectControlFlow(
	node: Script | Node,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	switch (node.type) {
		case "If":
			collectNode(node.clause, source, commands, groupId, ctx);
			collectNode(node.then, source, commands, groupId, ctx);
			if (node.else) collectNode(node.else, source, commands, groupId, ctx);
			return;

		case "While":
			collectNode(node.clause, source, commands, groupId, ctx);
			collectNode(node.body, source, commands, groupId, ctx);
			return;

		case "For":
			collectWord(node.name, source, commands, groupId, ctx);
			for (const word of node.wordlist) {
				collectWord(word, source, commands, groupId, ctx);
			}
			collectNode(node.body, source, commands, groupId, ctx);
			return;

		case "Select":
			collectWord(node.name, source, commands, groupId, ctx);
			for (const word of node.wordlist) {
				collectWord(word, source, commands, groupId, ctx);
			}
			collectNode(node.body, source, commands, groupId, ctx);
			return;

		case "Case":
			collectWord(node.word, source, commands, groupId, ctx);
			for (const item of node.items) {
				collectCaseItem(item, source, commands, groupId, ctx);
			}
			return;
	}
}

/** Handle remaining node types: Statement, Command, Subshell, BraceGroup,
 *  Function, Coproc, TestCommand, ArithmeticFor, ArithmeticCommand. */
function collectRemaining(
	node: Script | Node,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	switch (node.type) {
		case "Statement":
			collectNode(node.command, source, commands, groupId, ctx);
			for (const redirect of node.redirects) {
				collectRedirect(redirect, source, commands, groupId, ctx);
			}
			return;

		case "Command":
			collectCommand(node, source, commands, groupId, ctx);
			return;

		case "Subshell":
		case "BraceGroup":
			collectNode(node.body, source, commands, groupId, ctx);
			return;

		case "Function":
			collectWord(node.name, source, commands, groupId, ctx);
			collectNode(node.body, source, commands, groupId, ctx);
			for (const redirect of node.redirects) {
				collectRedirect(redirect, source, commands, groupId, ctx);
			}
			return;

		case "Coproc":
			if (node.name) collectWord(node.name, source, commands, groupId, ctx);
			collectNode(node.body, source, commands, groupId, ctx);
			for (const redirect of node.redirects) {
				collectRedirect(redirect, source, commands, groupId, ctx);
			}
			return;

		case "TestCommand":
			collectTestExpression(node.expression, source, commands, groupId, ctx);
			return;

		case "ArithmeticFor":
			collectArithmeticExpression(
				node.initialize,
				source,
				commands,
				groupId,
				ctx,
			);
			collectArithmeticExpression(node.test, source, commands, groupId, ctx);
			collectArithmeticExpression(node.update, source, commands, groupId, ctx);
			collectNode(node.body, source, commands, groupId, ctx);
			return;

		case "ArithmeticCommand":
			collectArithmeticExpression(
				node.expression,
				source,
				commands,
				groupId,
				ctx,
			);
			return;
	}
}

function collectCommand(
	node: Command,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (node.name || node.prefix.length > 0) {
		const parentGroup = ctx.groupParents.get(groupId);
		commands.push({
			node,
			source,
			group: groupId,
			...(parentGroup === undefined ? {} : { parentGroup }),
		});
	}

	for (const prefix of node.prefix) {
		collectAssignment(prefix, source, commands, groupId, ctx);
	}

	for (const word of node.suffix) {
		collectWord(word, source, commands, groupId, ctx);
	}

	for (const redirect of node.redirects) {
		collectRedirect(redirect, source, commands, groupId, ctx);
	}
}

function collectAssignment(
	assignment: AssignmentPrefix,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (assignment.value) {
		collectWord(assignment.value, source, commands, groupId, ctx);
	}

	if (assignment.array) {
		for (const word of assignment.array) {
			collectWord(word, source, commands, groupId, ctx);
		}
	}
}

function collectRedirect(
	redirect: Redirect,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (redirect.target) {
		collectWord(redirect.target, source, commands, groupId, ctx);
	}

	if (redirect.body?.parts) {
		collectWord(redirect.body, source, commands, groupId, ctx);
	}
}

function collectWord(
	word: Word | undefined,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (!word?.parts) return;
	for (const part of word.parts) {
		collectWordPart(part, source, commands, groupId, ctx);
	}
}

function collectWordPart(
	part: WordPart | CommandExpansionPart | ProcessSubstitutionPart,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	switch (part.type) {
		case "DoubleQuoted":
		case "LocaleString":
			for (const child of part.parts) {
				collectWordPart(child, source, commands, groupId, ctx);
			}
			return;

		case "CommandExpansion":
		case "ProcessSubstitution": {
			// Commands inside expansions get their own group
			const expansionGroup = allocGroupId(ctx, groupId);
			if (part.script) {
				// unbash 4.x keeps script positions absolute. Re-parse the inner
				// source to get a fresh AST with positions relative to inner text.
				const innerSource = expansionSource(part, source);
				const innerAst = parseBash(innerSource);
				collectNode(innerAst, innerSource, commands, expansionGroup, ctx);
			}
			return;
		}

		case "ParameterExpansion":
			collectParameterExpansion(part, source, commands, groupId, ctx);
			return;

		case "ArithmeticExpansion":
			collectArithmeticExpression(
				part.expression,
				source,
				commands,
				groupId,
				ctx,
			);
			return;

		default:
			return;
	}
}

function collectParameterExpansion(
	part: ParameterExpansionPart,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (part.operand) {
		collectWord(part.operand, source, commands, groupId, ctx);
	}

	if (part.slice) {
		collectWord(part.slice.offset, source, commands, groupId, ctx);
		if (part.slice.length) {
			collectWord(part.slice.length, source, commands, groupId, ctx);
		}
	}

	if (part.replace) {
		collectWord(part.replace.pattern, source, commands, groupId, ctx);
		collectWord(part.replace.replacement, source, commands, groupId, ctx);
	}
}

function expansionSource(
	part: CommandExpansionPart | ProcessSubstitutionPart,
	fallbackSource: string,
): string {
	if (part.inner != null) return part.inner;

	const text = part.text;
	if (text.startsWith("$(") && text.endsWith(")")) {
		return text.slice(2, -1);
	}
	if ((text.startsWith("<(") || text.startsWith(">(")) && text.endsWith(")")) {
		return text.slice(2, -1);
	}
	if (text.startsWith("`") && text.endsWith("`")) {
		return text.slice(1, -1);
	}

	return fallbackSource;
}

function collectCaseItem(
	item: { pattern: Word[]; body: Node },
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	for (const pattern of item.pattern) {
		collectWord(pattern, source, commands, groupId, ctx);
	}
	collectNode(item.body, source, commands, groupId, ctx);
}

function collectTestExpression(
	expr: TestExpression,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	switch (expr.type) {
		case "TestUnary":
			collectWord(expr.operand, source, commands, groupId, ctx);
			return;
		case "TestBinary":
			collectWord(expr.left, source, commands, groupId, ctx);
			collectWord(expr.right, source, commands, groupId, ctx);
			return;
		case "TestLogical":
			collectTestExpression(expr.left, source, commands, groupId, ctx);
			collectTestExpression(expr.right, source, commands, groupId, ctx);
			return;
		case "TestNot":
			collectTestExpression(expr.operand, source, commands, groupId, ctx);
			return;
		case "TestGroup":
			collectTestExpression(expr.expression, source, commands, groupId, ctx);
			return;
	}
}

function collectArithmeticExpression(
	expr: ArithmeticExpression | undefined,
	source: string,
	commands: CommandRef[],
	groupId: number,
	ctx: ExtractCtx,
) {
	if (!expr) return;

	switch (expr.type) {
		case "ArithmeticBinary":
			collectArithmeticExpression(expr.left, source, commands, groupId, ctx);
			collectArithmeticExpression(expr.right, source, commands, groupId, ctx);
			return;
		case "ArithmeticUnary":
			collectArithmeticExpression(expr.operand, source, commands, groupId, ctx);
			return;
		case "ArithmeticTernary":
			collectArithmeticExpression(expr.test, source, commands, groupId, ctx);
			collectArithmeticExpression(
				expr.consequent,
				source,
				commands,
				groupId,
				ctx,
			);
			collectArithmeticExpression(
				expr.alternate,
				source,
				commands,
				groupId,
				ctx,
			);
			return;
		case "ArithmeticGroup":
			collectArithmeticExpression(
				expr.expression,
				source,
				commands,
				groupId,
				ctx,
			);
			return;
		case "ArithmeticCommandExpansion": {
			// Commands inside arithmetic expansions get their own group
			const expansionGroup = allocGroupId(ctx, groupId);
			if (expr.script) {
				// unbash 4.x keeps script positions absolute. Re-parse the inner
				// source to get a fresh AST with positions relative to inner text.
				const innerSource =
					expr.text.startsWith("$(") && expr.text.endsWith(")")
						? expr.text.slice(2, -1)
						: expr.text;
				const innerAst = parseBash(innerSource);
				collectNode(innerAst, innerSource, commands, expansionGroup, ctx);
			} else if (expr.inner) {
				// Parse the inner text and collect commands (for double-quoted context)
				const innerAst = parseBash(expr.inner);
				collectNode(innerAst, expr.inner, commands, expansionGroup, ctx);
			}
			return;
		}
		case "ArithmeticWord":
			return;
	}
}
