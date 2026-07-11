import type {
	AssignmentPrefix,
	CommandExpansionPart,
	DoubleQuotedPart,
	LocaleStringPart,
	ProcessSubstitutionPart,
	Redirect,
	Word,
	WordPart,
} from "unbash";
import type { CommandRef } from "./types.ts";

const FORMAT_COMMAND_DEFAULT_MAX_LENGTH = 120;
const FORMAT_COMMAND_DEFAULT_ARG_MAX_LENGTH = 40;

export function truncate(s: string, maxLength: number): string {
	return s.length > maxLength ? `${s.slice(0, maxLength - 1)}…` : s;
}

/**
 * Format an extracted command for display in an approval prompt.
 *
 * The raw command string can be long and hard to scan, so we re-serialize from
 * AST tokens and elide just enough to fit the prompt while keeping the command
 * recognizable. This matters because the user needs to see at a glance what is
 * being executed and whether each line is allowed (✔) or blocked (✖).
 *
 * The command name is always shown verbatim. If the full command fits, it is
 * shown unchanged. Otherwise, the formatter starts from the full display and
 * shrinks later tokens only as much as needed to fit within maxLength:
 *   - Path-like tokens get path-aware middle elision that preserves the tail.
 *   - Other tokens are prefix-truncated with "…".
 *   - argMaxLength acts as the minimum per-token elision target, not a hard cap
 *     when there is still room in the overall maxLength budget.
 * If the total result still exceeds maxLength, it is hard-truncated with "…".
 */
export function formatCommand(
	cmd: CommandRef,
	options?: { maxLength?: number; argMaxLength?: number },
): string {
	const maxLength = options?.maxLength ?? FORMAT_COMMAND_DEFAULT_MAX_LENGTH;
	const argMaxLength =
		options?.argMaxLength ?? FORMAT_COMMAND_DEFAULT_ARG_MAX_LENGTH;

	// Assignment-only command (e.g. TOKEN=$(...)): display prefix assignments
	if (!cmd.node.name && cmd.node.prefix.length > 0) {
		return formatAssignmentOnlyCommand(cmd, maxLength, argMaxLength);
	}

	const name = displayWordElidingExpansions(cmd.node.name, cmd.source).replace(
		/\n/g,
		"↵",
	);
	const tokenSpecs = [
		...cmd.node.suffix.map((arg) => {
			const full = displayWordElidingExpansions(arg, cmd.source).replace(
				/\n/g,
				"↵",
			);
			return { full, min: elideToken(full, argMaxLength) };
		}),
		...redirectsToTokenSpecs(cmd.node.redirects, cmd.source, argMaxLength),
	];

	const fullDisplay = [name, ...tokenSpecs.map((spec) => spec.full)].join(" ");
	if (fullDisplay.length <= maxLength) return fullDisplay;

	return shrinkTokens([name], tokenSpecs, fullDisplay, maxLength);
}

function isRenderableHeredoc(redirect: Redirect): boolean {
	return (
		(redirect.operator === "<<" || redirect.operator === "<<-") &&
		redirect.content != null
	);
}

function redirectsToTokenSpecs(
	redirects: Redirect[],
	source: string,
	argMaxLength: number,
): { full: string; min: string }[] {
	return redirects.map((redirect) => {
		if (isRenderableHeredoc(redirect)) {
			const full = renderFullHeredoc(redirect, source);
			const min = renderElidedHeredoc(redirect, source, argMaxLength);
			return { full, min };
		}
		const full = renderRedirect(redirect, source).replace(/\n/g, "↵");
		return { full, min: elideToken(full, argMaxLength) };
	});
}

function renderRedirect(redirect: Redirect, source: string): string {
	const sliced = source.slice(redirect.pos, redirect.end);
	return sliced.length > 0 ? sliced : redirect.operator;
}

function heredocPrefix(redirect: Redirect, source: string): string {
	return `${redirectPrefix(redirect)}${heredocTargetDisplay(redirect, source)}↵`;
}

function renderFullHeredoc(redirect: Redirect, source: string): string {
	return `${heredocPrefix(redirect, source)}${(redirect.content ?? "").replace(/\n/g, "↵")}${heredocMarker(redirect, source)}`;
}

function renderElidedHeredoc(
	redirect: Redirect,
	source: string,
	argMaxLength: number,
): string {
	const prefix = heredocPrefix(redirect, source);
	const content = (redirect.content ?? "").replace(/\n/g, "↵");
	const full = content + heredocMarker(redirect, source);

	if (full.length <= argMaxLength) {
		return prefix + full;
	}

	return `${prefix}${content.slice(0, argMaxLength)}…`;
}

function redirectPrefix(redirect: Redirect): string {
	const fd =
		redirect.fileDescriptor != null ? String(redirect.fileDescriptor) : "";
	const variableName = redirect.variableName
		? `{${redirect.variableName}}`
		: "";
	return `${fd}${variableName}${redirect.operator}`;
}

function heredocTargetDisplay(redirect: Redirect, source: string): string {
	const marker = rawHeredocMarker(redirect, source);
	return redirect.heredocQuoted ? `'${marker}'` : marker;
}

function heredocMarker(redirect: Redirect, source: string): string {
	return rawHeredocMarker(redirect, source).replaceAll("\\", "");
}

function rawHeredocMarker(redirect: Redirect, source: string): string {
	if (!redirect.target) return "";
	const raw = displayWord(redirect.target, source);
	return raw.length > 0 ? raw : (redirect.target.value ?? redirect.target.text);
}

function displayWord(word: Word | undefined, source: string): string {
	if (!word) return "";
	const sliced = source.slice(word.pos, word.end);
	return sliced.length > 0 ? sliced : word.text;
}

/**
 * Display a word with command expansions and process substitutions replaced
 * by `...`. This avoids duplicating sub-command content that appears on
 * subsequent lines of the approval prompt.
 *
 * For example, `echo $(cat foo | grep bar)` displays as `echo $(...)`
 * instead of `echo $(cat foo | grep bar)`.
 */
function displayWordElidingExpansions(
	word: Word | undefined,
	source: string,
): string {
	if (!word) return "";
	if (!word.parts) return displayWord(word, source);
	return reconstructWordElidingExpansions(word.parts, source);
}

function reconstructWordElidingExpansions(
	parts: WordPart[] | undefined,
	source: string,
): string {
	if (!parts) return "";
	let result = "";
	for (const part of parts) {
		switch (part.type) {
			case "CommandExpansion":
				result += elideCommandExpansion(part);
				break;
			case "ProcessSubstitution":
				result += elideProcessSubstitution(part);
				break;
			case "DoubleQuoted":
			case "LocaleString":
				result += reconstructQuotedExpansion(part, source);
				break;
			default:
				// Literal, SingleQuoted, AnsiCQuoted, SimpleExpansion,
				// ParameterExpansion, ArithmeticExpansion, ExtendedGlob, BraceExpansion
				result +=
					"pos" in part && "end" in part
						? source.slice(part.pos as number, part.end as number) || part.text
						: part.text;
				break;
		}
	}
	return result;
}

function elideCommandExpansion(part: CommandExpansionPart): string {
	const text = part.text;
	if (text.startsWith("$(") && text.endsWith(")")) {
		return "$(...)";
	}
	if (text.startsWith("`") && text.endsWith("`")) {
		return "`...`";
	}
	// Fallback: replace the inner content with ...
	return text;
}

function elideProcessSubstitution(part: ProcessSubstitutionPart): string {
	const op = part.operator === ">" ? ">" : "<";
	return `${op}(...)`;
}

function reconstructQuotedExpansion(
	part: DoubleQuotedPart | LocaleStringPart,
	source: string,
): string {
	const inner = reconstructWordElidingExpansions(part.parts, source);
	// Double-quoted: wrap in quotes
	if (part.type === "DoubleQuoted") return `"${inner}"`;
	// Locale string ($"..."): preserve the $"..." syntax
	return `$"${inner}"`;
}

function elideToken(token: string, argMaxLength: number): string {
	if (isPathToken(token)) {
		const elided = elidePath(token);
		return elided.length < token.length ? elided : token;
	}
	if (token.length > argMaxLength) {
		return `${token.slice(0, argMaxLength)}…`;
	}
	return token;
}

/**
 * A display token with pre-computed bounds for the shrinker.
 *
 * full — the longest the token will ever be shown (used when the command fits)
 * min  — the shortest it can be truncated to (elided form, floor for shrinker)
 *
 * We carry both instead of computing min on demand because heredocs have a
 * structurally different minimum (renderElidedHeredoc) that can't be derived
 * from full alone. Pre-computing keeps the shrinker uniform.
 */
interface TokenSpec {
	full: string;
	min: string;
}

function shrinkToken(spec: TokenSpec, targetLength: number): string {
	if (spec.full.length <= targetLength) return spec.full;
	if (targetLength <= spec.min.length) return spec.min;
	if (targetLength <= 1) return "…";
	if (isPathToken(spec.full)) return shrinkPathToken(spec.full, targetLength);
	return truncate(spec.full, targetLength);
}

/**
 * Shrink tokens from right to left until the combined display fits within
 * maxLength.
 *
 * The command name and early arguments are usually the most recognizable
 * parts of a command, so we preserve them and only elide trailing tokens.
 * Each token is shrunk only as much as needed, and never below its minimum
 * (elided) length. head strings (name, assignments, etc.) are never shrunk —
 * only the tokenSpecs are.
 */
function shrinkTokens(
	head: string[],
	tokenSpecs: TokenSpec[],
	fullDisplay: string,
	maxLength: number,
): string {
	const tokens = tokenSpecs.map((spec) => spec.full);
	let overflow = fullDisplay.length - maxLength;

	for (let i = tokenSpecs.length - 1; i >= 0 && overflow > 0; i--) {
		const spec = tokenSpecs[i];
		const current = tokens[i];
		if (!spec || !current) continue;
		const maxShrink = current.length - spec.min.length;
		if (maxShrink <= 0) continue;

		const nextTargetLength = current.length - Math.min(maxShrink, overflow);
		const shrunk = shrinkToken(spec, nextTargetLength);
		tokens[i] = shrunk;
		overflow -= current.length - shrunk.length;
	}

	return truncate([...head, ...tokens].join(" "), maxLength);
}

/**
 * Path-like detection using character composition.
 *
 * A simple "contains /" check would misclassify sed scripts (e.g.
 * s/foo/bar/), URLs, and flag arguments as paths. We use a high ratio of
 * path-safe characters and very few spaces so legitimate paths get
 * path-aware elision while sentences, scripts, and URLs are left alone.
 *
 * A token is considered path-like if:
 *   - It contains a slash (required)
 *   - It is not a URL (no ://)
 *   - After stripping surrounding quotes, the non-space characters are
 *     ≥85% path-safe ([a-zA-Z0-9/._~$@%+=,:-]) — handles bare relative
 *     paths like packages/tui/src/terminal.ts and quoted paths with $
 *     like "$PROJECT_ROOT/src/routes/$page.tsx"
 *   - Spaces don't exceed 10% of the inner length (guards against sentences
 *     that happen to contain a slash)
 */
function formatAssignmentOnlyCommand(
	cmd: CommandRef,
	maxLength: number,
	argMaxLength: number,
): string {
	const assignments = cmd.node.prefix.map((a) =>
		formatAssignment(a, cmd.source).replace(/\n/g, "↵"),
	);
	const tokenSpecs = redirectsToTokenSpecs(
		cmd.node.redirects,
		cmd.source,
		argMaxLength,
	);

	const fullDisplay = [
		...assignments,
		...tokenSpecs.map((spec) => spec.full),
	].join(" ");
	if (fullDisplay.length <= maxLength) return fullDisplay;

	return shrinkTokens(assignments, tokenSpecs, fullDisplay, maxLength);
}

/** Format a single prefix assignment (e.g. "TOKEN=$(...)" or "FOO=bar"). */
function formatAssignment(
	assignment: AssignmentPrefix,
	source: string,
): string {
	const name = assignment.index
		? `${assignment.name}[${assignment.index}]`
		: (assignment.name ?? "");
	const op = assignment.append ? "+=" : "=";

	if (assignment.array) {
		const elements = assignment.array
			.map((w) => displayWordElidingExpansions(w, source))
			.join(" ");
		return `${name}${op}(${elements})`;
	}

	const value = assignment.value
		? displayWordElidingExpansions(assignment.value, source)
		: "";
	return `${name}${op}${value}`;
}

function isPathToken(token: string): boolean {
	if (!token.includes("/")) return false;
	if (token.includes("://")) return false;
	const inner = token.replace(/^["']|["']$/g, "");
	const spaces = (inner.match(/ /g) ?? []).length;
	if (spaces / inner.length > 0.1) return false;
	const nonSpace = inner.replace(/ /g, "");
	if (nonSpace.length === 0) return false;
	const safe = (nonSpace.match(/[a-zA-Z0-9/._~$@%+=,:-]/g) ?? []).length;
	return safe / nonSpace.length >= 0.85;
}

/**
 * Path-aware elision: keep the first two segments and the last.
 * /Users/jdiamond/code/pi-unbash → /Users/…/pi-unbash
 */
function elidePath(p: string): string {
	const parts = p.split("/");
	if (parts.length <= 3) return p;
	return `${parts.slice(0, 2).join("/")}/…/${parts[parts.length - 1]}`;
}

function shrinkPathToken(token: string, targetLength: number): string {
	const lastSlash = token.lastIndexOf("/");
	if (lastSlash <= 0) {
		return truncate(token, targetLength);
	}

	const suffix = token.slice(lastSlash);
	const prefixBudget = targetLength - suffix.length - 1;
	if (prefixBudget <= 0) {
		return truncate(token, targetLength);
	}

	return `${token.slice(0, prefixBudget)}…${suffix}`;
}
