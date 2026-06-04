/**
 * Hand-rolled, dependency-free parsers for the two relaxed JSON dialects that
 * Renovate accepts in its config files:
 *
 * - {@link parseJsonc} for JSONC — plain JSON plus `//` and `/* *​/` comments
 *   and trailing commas. Used for `.json`, `.jsonc` and extension-less files.
 * - {@link parseJson5} for JSON5 — a strict superset of JSONC that also allows
 *   single-quoted strings, unquoted identifier keys and extended number
 *   literals. Used for `.json5` files.
 *
 * Both throw on invalid input, mirroring the built-in `JSON.parse`. The
 * Renovate-facing wrappers in `./renovate.ts` catch and translate those throws
 * into a `Result`.
 */

const JSON5_WHITESPACE =
	/[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const HEX_DIGIT = /[0-9a-fA-F]/;
const DIGIT = /[0-9]/;

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

/**
 * Strip `//` and block comments, replacing them with nothing while leaving the
 * surrounding text (including string literals) untouched. Comment markers that
 * appear inside a string are preserved.
 */
function stripComments(text: string): string {
	let out = "";
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		if (char === '"') {
			const end = scanString(text, index);
			out += text.slice(index, end);
			index = end;
			continue;
		}
		if (char === "/" && text[index + 1] === "/") {
			index += 2;
			while (index < text.length && text[index] !== "\n") {
				index++;
			}
			continue;
		}
		if (char === "/" && text[index + 1] === "*") {
			index += 2;
			while (
				index < text.length &&
				!(text[index] === "*" && text[index + 1] === "/")
			) {
				index++;
			}
			index += 2;
			continue;
		}
		out += char;
		index++;
	}
	return out;
}

/**
 * Given the index of an opening `"`, return the index just past the matching
 * closing quote, honouring backslash escapes.
 */
function scanString(text: string, start: number): number {
	let index = start + 1;
	while (index < text.length) {
		const char = text[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		index++;
		if (char === '"') {
			break;
		}
	}
	return index;
}

/** Remove commas that directly precede a closing `}` or `]`, ignoring strings. */
function removeTrailingCommas(text: string): string {
	let out = "";
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		if (char === '"') {
			const end = scanString(text, index);
			out += text.slice(index, end);
			index = end;
			continue;
		}
		if (char === ",") {
			let lookahead = index + 1;
			while (
				lookahead < text.length &&
				JSON5_WHITESPACE.test(text[lookahead])
			) {
				lookahead++;
			}
			if (text[lookahead] === "}" || text[lookahead] === "]") {
				index++;
				continue;
			}
		}
		out += char;
		index++;
	}
	return out;
}

/**
 * Parse JSONC: JSON extended with comments and trailing commas. The relaxations
 * are stripped textually and the remainder is handed to the strict, native
 * `JSON.parse`, so anything JSON itself rejects (single quotes, unquoted keys)
 * still throws.
 */
export function parseJsonc(text: string): unknown {
	return JSON.parse(removeTrailingCommas(stripComments(text)));
}

// ---------------------------------------------------------------------------
// JSON5
// ---------------------------------------------------------------------------

interface Cursor {
	pos: number;
	readonly text: string;
}

const fail = (cursor: Cursor, message: string): never => {
	throw new Error(`Invalid JSON5 at position ${cursor.pos}: ${message}`);
};

/** Skip whitespace and both comment styles. */
function skipTrivia(cursor: Cursor): void {
	const { text } = cursor;
	while (cursor.pos < text.length) {
		const char = text[cursor.pos];
		if (JSON5_WHITESPACE.test(char)) {
			cursor.pos++;
			continue;
		}
		if (char === "/" && text[cursor.pos + 1] === "/") {
			cursor.pos += 2;
			while (cursor.pos < text.length && text[cursor.pos] !== "\n") {
				cursor.pos++;
			}
			continue;
		}
		if (char === "/" && text[cursor.pos + 1] === "*") {
			cursor.pos += 2;
			while (
				cursor.pos < text.length &&
				!(text[cursor.pos] === "*" && text[cursor.pos + 1] === "/")
			) {
				cursor.pos++;
			}
			cursor.pos += 2;
			continue;
		}
		break;
	}
}

/** Read `length` hex digits and decode them to a single character. */
function readHex(cursor: Cursor, length: number): string {
	const start = cursor.pos;
	for (let i = 0; i < length; i++) {
		if (!HEX_DIGIT.test(cursor.text[cursor.pos] ?? "")) {
			return fail(cursor, "invalid hex escape");
		}
		cursor.pos++;
	}
	return String.fromCharCode(
		Number.parseInt(cursor.text.slice(start, cursor.pos), 16),
	);
}

const SIMPLE_ESCAPES: Record<string, string> = {
	'"': '"',
	"'": "'",
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"0": "\0",
};

/** Decode the escape sequence at the cursor (positioned on the backslash). */
function readEscape(cursor: Cursor): string {
	cursor.pos++; // consume the backslash
	const char = cursor.text[cursor.pos];
	cursor.pos++;
	if (char === "x") {
		return readHex(cursor, 2);
	}
	if (char === "u") {
		return readHex(cursor, 4);
	}
	// Line continuation: a backslash before a newline yields nothing.
	if (char === "\n") {
		return "";
	}
	if (char === "\r") {
		if (cursor.text[cursor.pos] === "\n") {
			cursor.pos++;
		}
		return "";
	}
	return SIMPLE_ESCAPES[char] ?? char ?? "";
}

/** Read a single- or double-quoted string (cursor on the opening quote). */
function readString(cursor: Cursor): string {
	const quote = cursor.text[cursor.pos];
	cursor.pos++;
	let out = "";
	while (cursor.pos < cursor.text.length) {
		const char = cursor.text[cursor.pos];
		if (char === quote) {
			cursor.pos++;
			return out;
		}
		if (char === "\\") {
			out += readEscape(cursor);
			continue;
		}
		if (char === "\n" || char === "\r") {
			return fail(cursor, "unterminated string");
		}
		out += char;
		cursor.pos++;
	}
	return fail(cursor, "unterminated string");
}

/** Consume an unquoted ECMAScript-identifier object key. */
function readIdentifier(cursor: Cursor): string {
	const start = cursor.pos;
	if (!IDENTIFIER_START.test(cursor.text[cursor.pos] ?? "")) {
		return fail(cursor, "expected property name");
	}
	cursor.pos++;
	while (IDENTIFIER_PART.test(cursor.text[cursor.pos] ?? "")) {
		cursor.pos++;
	}
	return cursor.text.slice(start, cursor.pos);
}

function readDecimalDigits(cursor: Cursor): void {
	while (DIGIT.test(cursor.text[cursor.pos] ?? "")) {
		cursor.pos++;
	}
}

/** Read a number literal: signs, hex, Infinity, NaN, decimals, exponents. */
function readNumber(cursor: Cursor): number {
	const { text } = cursor;
	const start = cursor.pos;
	let sign = 1;
	if (text[cursor.pos] === "+") {
		cursor.pos++;
	} else if (text[cursor.pos] === "-") {
		sign = -1;
		cursor.pos++;
	}
	if (text.startsWith("Infinity", cursor.pos)) {
		cursor.pos += "Infinity".length;
		return sign * Number.POSITIVE_INFINITY;
	}
	if (text.startsWith("NaN", cursor.pos)) {
		cursor.pos += "NaN".length;
		return Number.NaN;
	}
	if (
		text[cursor.pos] === "0" &&
		(text[cursor.pos + 1] ?? "").toLowerCase() === "x"
	) {
		cursor.pos += 2;
		const hexStart = cursor.pos;
		while (HEX_DIGIT.test(text[cursor.pos] ?? "")) {
			cursor.pos++;
		}
		if (cursor.pos === hexStart) {
			return fail(cursor, "invalid hex number");
		}
		return sign * Number.parseInt(text.slice(hexStart, cursor.pos), 16);
	}
	readDecimalDigits(cursor);
	if (text[cursor.pos] === ".") {
		cursor.pos++;
		readDecimalDigits(cursor);
	}
	if (text[cursor.pos] === "e" || text[cursor.pos] === "E") {
		cursor.pos++;
		if (text[cursor.pos] === "+" || text[cursor.pos] === "-") {
			cursor.pos++;
		}
		readDecimalDigits(cursor);
	}
	const literal = text.slice(start, cursor.pos);
	const value = Number(literal);
	if (
		literal === "" ||
		literal === "+" ||
		literal === "-" ||
		Number.isNaN(value)
	) {
		return fail(cursor, "invalid number");
	}
	return value;
}

function readObject(cursor: Cursor): Record<string, unknown> {
	cursor.pos++; // consume "{"
	const obj: Record<string, unknown> = {};
	skipTrivia(cursor);
	if (cursor.text[cursor.pos] === "}") {
		cursor.pos++;
		return obj;
	}
	while (true) {
		skipTrivia(cursor);
		const keyChar = cursor.text[cursor.pos];
		const key =
			keyChar === '"' || keyChar === "'"
				? readString(cursor)
				: readIdentifier(cursor);
		skipTrivia(cursor);
		if (cursor.text[cursor.pos] !== ":") {
			return fail(cursor, "expected ':'");
		}
		cursor.pos++;
		obj[key] = readValue(cursor);
		skipTrivia(cursor);
		const next = cursor.text[cursor.pos];
		if (next === ",") {
			cursor.pos++;
			skipTrivia(cursor);
			if (cursor.text[cursor.pos] === "}") {
				cursor.pos++;
				return obj;
			}
			continue;
		}
		if (next === "}") {
			cursor.pos++;
			return obj;
		}
		return fail(cursor, "expected ',' or '}'");
	}
}

function readArray(cursor: Cursor): unknown[] {
	cursor.pos++; // consume "["
	const arr: unknown[] = [];
	skipTrivia(cursor);
	if (cursor.text[cursor.pos] === "]") {
		cursor.pos++;
		return arr;
	}
	while (true) {
		arr.push(readValue(cursor));
		skipTrivia(cursor);
		const next = cursor.text[cursor.pos];
		if (next === ",") {
			cursor.pos++;
			skipTrivia(cursor);
			if (cursor.text[cursor.pos] === "]") {
				cursor.pos++;
				return arr;
			}
			continue;
		}
		if (next === "]") {
			cursor.pos++;
			return arr;
		}
		return fail(cursor, "expected ',' or ']'");
	}
}

const NUMBER_START = /[-+.0-9]/;

function readValue(cursor: Cursor): unknown {
	skipTrivia(cursor);
	const char = cursor.text[cursor.pos];
	if (char === undefined) {
		return fail(cursor, "unexpected end of input");
	}
	if (char === "{") {
		return readObject(cursor);
	}
	if (char === "[") {
		return readArray(cursor);
	}
	if (char === '"' || char === "'") {
		return readString(cursor);
	}
	if (cursor.text.startsWith("true", cursor.pos)) {
		cursor.pos += "true".length;
		return true;
	}
	if (cursor.text.startsWith("false", cursor.pos)) {
		cursor.pos += "false".length;
		return false;
	}
	if (cursor.text.startsWith("null", cursor.pos)) {
		cursor.pos += "null".length;
		return null;
	}
	if (NUMBER_START.test(char) || char === "I" || char === "N") {
		return readNumber(cursor);
	}
	return fail(cursor, `unexpected character ${JSON.stringify(char)}`);
}

/**
 * Parse JSON5: a superset of JSONC that additionally allows single-quoted
 * strings, unquoted identifier keys, hex/`Infinity`/`NaN`/signed number
 * literals, and line continuations inside strings.
 */
export function parseJson5(text: string): unknown {
	const cursor: Cursor = { text, pos: 0 };
	const value = readValue(cursor);
	skipTrivia(cursor);
	if (cursor.pos !== text.length) {
		return fail(cursor, "unexpected trailing characters");
	}
	return value;
}
