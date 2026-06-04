import { describe, expect, it } from "vitest";
import { parseJson5, parseJsonc } from "../src/json.ts";

const TRAILING_ERROR = /trailing/;
const UNTERMINATED_ERROR = /unterminated/;
const SEPARATOR_ERROR = /','/;
const HEX_ERROR = /hex/;
const UNEXPECTED_CHAR_ERROR = /unexpected character/;
const UNEXPECTED_END_ERROR = /unexpected end/;

describe("parseJsonc", () => {
	it("parses plain JSON", () => {
		expect(parseJsonc('{"a":1,"b":[true,null,"x"]}')).toEqual({
			a: 1,
			b: [true, null, "x"],
		});
	});

	it("strips line and block comments", () => {
		const text = `{
      // a leading comment
      "a": 1, /* inline */ "b": 2
      /* trailing
         block */
    }`;
		expect(parseJsonc(text)).toEqual({ a: 1, b: 2 });
	});

	it("tolerates trailing commas in objects and arrays", () => {
		expect(parseJsonc('{ "a": [1, 2, 3,], "b": 2, }')).toEqual({
			a: [1, 2, 3],
			b: 2,
		});
	});

	it("does not treat comment markers inside strings as comments", () => {
		expect(parseJsonc('{ "url": "https://example.com" }')).toEqual({
			url: "https://example.com",
		});
	});

	it("keeps a comma that lives inside a string", () => {
		expect(parseJsonc('{ "a": "x,}", "b": 2 }')).toEqual({ a: "x,}", b: 2 });
	});

	it("rejects JSON5-only syntax such as single quotes", () => {
		expect(() => parseJsonc("{ 'a': 1 }")).toThrow();
	});

	it("throws on malformed input", () => {
		expect(() => parseJsonc("{ not json")).toThrow();
	});
});

describe("parseJson5", () => {
	it("parses everything JSONC can", () => {
		const text = `{
      // comment
      "a": 1,
      "b": [1, 2,],
    }`;
		expect(parseJson5(text)).toEqual({ a: 1, b: [1, 2] });
	});

	it("accepts single-quoted strings and unquoted keys", () => {
		expect(parseJson5("{ extends: ['config:recommended'], a: 1 }")).toEqual({
			extends: ["config:recommended"],
			a: 1,
		});
	});

	it("supports identifier keys with $ and _ characters", () => {
		expect(parseJson5("{ $schema: 'x', _id: 1 }")).toEqual({
			$schema: "x",
			_id: 1,
		});
	});

	it("decodes string escapes including \\x and \\u", () => {
		expect(parseJson5(String.raw`"tab\there \x41 B"`)).toBe("tab\there A B");
	});

	it("treats a backslash-newline as a line continuation", () => {
		expect(parseJson5('"line1\\\nline2"')).toBe("line1line2");
	});

	it("parses extended number literals", () => {
		expect(
			parseJson5("[0xFF, +1.5, -.5, 5., 1e3, Infinity, -Infinity]"),
		).toEqual([
			255,
			1.5,
			-0.5,
			5,
			1000,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]);
	});

	it("parses NaN", () => {
		expect(parseJson5("NaN")).toBeNaN();
	});

	it("parses booleans and null", () => {
		expect(parseJson5("[true, false, null]")).toEqual([true, false, null]);
	});

	it("handles empty objects and arrays", () => {
		expect(parseJson5("{}")).toEqual({});
		expect(parseJson5("[]")).toEqual([]);
	});

	it("throws on trailing characters", () => {
		expect(() => parseJson5("{} garbage")).toThrow(TRAILING_ERROR);
	});

	it("throws on an unterminated string", () => {
		expect(() => parseJson5('"oops')).toThrow(UNTERMINATED_ERROR);
	});

	it("throws on a missing colon", () => {
		expect(() => parseJson5("{ a 1 }")).toThrow();
	});

	it("throws on a malformed array separator", () => {
		expect(() => parseJson5("[1 2]")).toThrow(SEPARATOR_ERROR);
	});

	it("throws on a malformed object separator", () => {
		expect(() => parseJson5('{ "a": 1 "b": 2 }')).toThrow(SEPARATOR_ERROR);
	});

	it("throws on an invalid hex escape", () => {
		expect(() => parseJson5(String.raw`"\xZZ"`)).toThrow(HEX_ERROR);
	});

	it("throws on an empty hex number", () => {
		expect(() => parseJson5("0x")).toThrow(HEX_ERROR);
	});

	it("throws on an unexpected character", () => {
		expect(() => parseJson5("@")).toThrow(UNEXPECTED_CHAR_ERROR);
	});

	it("throws on empty input", () => {
		expect(() => parseJson5("")).toThrow(UNEXPECTED_END_ERROR);
	});
});
