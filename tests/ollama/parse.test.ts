import { describe, expect, it } from "vitest";

import { isStrataError } from "../../src/errors.js";
import {
  compressionJsonSchema,
  extractJsonObjects,
  parseCompressionResult,
} from "../../src/ollama/parse.js";

const wellFormed = '{"summary":"Pool raised to 50.","suggested_tags":["postgres"]}';

/** Assert a response is rejected as unusable model output. */
function expectBadResponse(raw: string): void {
  try {
    parseCompressionResult(raw);
    throw new Error("expected parseCompressionResult to throw");
  } catch (error) {
    if (!isStrataError(error)) {
      throw error;
    }
    expect(error.code).toBe("OLLAMA_BAD_RESPONSE");
  }
}

describe("extractJsonObjects", () => {
  it("finds a bare object", () => {
    expect(extractJsonObjects('{"a":1}')).toEqual(['{"a":1}']);
  });

  it("returns nothing for truncated input", () => {
    // The signal we rely on to distinguish "cut off" from "malformed".
    expect(extractJsonObjects('{"a":1')).toEqual([]);
    expect(extractJsonObjects("no json here")).toEqual([]);
    expect(extractJsonObjects("")).toEqual([]);
  });

  it("ignores braces inside strings", () => {
    expect(extractJsonObjects('{"a":"use the {} form"}')).toEqual([
      '{"a":"use the {} form"}',
    ]);
  });

  it("ignores escaped quotes when tracking strings", () => {
    const input = '{"a":"he said \\"hi\\" then {"}';
    expect(extractJsonObjects(input)).toEqual([input]);
  });

  it("captures the whole outer object when nested", () => {
    expect(extractJsonObjects('{"a":{"b":1}}')).toEqual(['{"a":{"b":1}}']);
  });

  it("returns multiple top-level objects in order", () => {
    expect(extractJsonObjects('{"a":1} and {"b":2}')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("ignores an unmatched closing brace", () => {
    expect(extractJsonObjects('} {"a":1}')).toEqual(['{"a":1}']);
  });
});

describe("parseCompressionResult — the malformed shapes a 3B model produces", () => {
  it("parses clean JSON", () => {
    const result = parseCompressionResult(wellFormed);
    expect(result.summary).toBe("Pool raised to 50.");
    expect(result.suggested_tags).toEqual(["postgres"]);
  });

  it("parses JSON inside markdown fences", () => {
    expect(parseCompressionResult(`\`\`\`json\n${wellFormed}\n\`\`\``).summary).toBe(
      "Pool raised to 50.",
    );
  });

  it("parses JSON wrapped in prose", () => {
    expect(
      parseCompressionResult(`Sure! Here is the JSON:\n${wellFormed}\nHope that helps.`)
        .summary,
    ).toBe("Pool raised to 50.");
  });

  it("skips brace-containing narration before the real object", () => {
    // The case that defeats a naive first-{-to-last-} extraction.
    const raw = `Here is the result { as requested }: ${wellFormed}`;
    expect(parseCompressionResult(raw).summary).toBe("Pool raised to 50.");
  });

  it("skips a valid-JSON-but-wrong-shape object before the right one", () => {
    const raw = `{"thinking":"let me see"} ${wellFormed}`;
    expect(parseCompressionResult(raw).summary).toBe("Pool raised to 50.");
  });

  it("defaults missing suggested_tags rather than failing", () => {
    const result = parseCompressionResult('{"summary":"A fact."}');
    expect(result.suggested_tags).toEqual([]);
  });

  it("rejects truncated JSON", () => {
    expectBadResponse('{"summary":"Pool raised to 50.","suggested_tag');
  });

  it("rejects a response with no JSON at all", () => {
    expectBadResponse("I'm sorry, I can't help with that.");
    expectBadResponse("");
  });

  it("rejects valid JSON with the wrong field names", () => {
    expectBadResponse('{"text":"A fact.","keywords":["a"]}');
  });

  it("rejects an empty summary", () => {
    expectBadResponse('{"summary":"","suggested_tags":[]}');
  });

  it("rejects a summary of the wrong type", () => {
    expectBadResponse('{"summary":42,"suggested_tags":[]}');
  });

  it("rejects tags of the wrong element type", () => {
    expectBadResponse('{"summary":"A fact.","suggested_tags":[1,2]}');
  });

  it("truncates an over-long summary instead of discarding the call", () => {
    // Raw content is retained, so clipping is recoverable; rejecting would waste
    // the model call and leave the row raw for no benefit.
    const long = "x".repeat(20_000);
    const result = parseCompressionResult(JSON.stringify({ summary: long }));
    expect(result.summary.length).toBe(8_000);
  });

  it("reports why it failed", () => {
    try {
      parseCompressionResult('{"text":"wrong"}');
      throw new Error("expected throw");
    } catch (error) {
      if (!isStrataError(error)) {
        throw error;
      }
      expect(error.message).toContain("summary");
    }
  });
});

describe("compressionJsonSchema", () => {
  it("describes an object with the two expected properties", () => {
    const schema = compressionJsonSchema();
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual([
      "summary",
      "suggested_tags",
    ]);
  });
});
