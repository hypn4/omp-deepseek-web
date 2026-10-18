import { describe, expect, test } from "bun:test";
import { DeepSeekSseParser } from "../src/deepseek/sse";

describe("DeepSeekSseParser", () => {
  test("replays a captured stream into the final response text", () => {
    const stream = [
      "event: ready",
      'data: {"request_message_id":1,"response_message_id":2}',
      "",
      'data: {"v":{"response":{"status":"WIP","fragments":[{"type":"RESPONSE","content":""}]}}}',
      "",
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"O"}',
      "",
      'data: {"v":"K"}',
      "",
      'data: {"p":"response","o":"BATCH","v":[{"p":"fragments","o":"APPEND","v":[{"type":"RESPONSE","content":""}]},{"p":"status","o":"SET","v":"WIP"}]}',
      "",
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
      "",
      "event: title",
      'data: {"title":"Greeting"}',
      "",
      "event: close",
      "",
    ].join("\n");

    const parser = new DeepSeekSseParser();
    parser.feed(stream);

    expect(parser.result()).toEqual({
      text: "OK",
      thinking: "",
      finished: true,
    });
  });

  test("keeps THINK and RESPONSE fragments separate", () => {
    const parser = new DeepSeekSseParser();
    parser.feed(
      [
        "event: ready",
        'data: {"v":{"response":{"status":"WIP","fragments":[{"type":"THINK","content":"hmm"}]}}}',
        'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"THINK","content":" more"},{"type":"RESPONSE","content":"Hi"}]}',
        'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" there"}',
        "event: close",
        "",
      ].join("\n"),
    );

    expect(parser.result()).toEqual({
      text: "Hi there",
      thinking: "hmm more",
      finished: true,
    });
  });

  test("handles chunk boundaries that split lines and JSON payloads", () => {
    const stream = [
      'data: {"v":{"response":{"status":"WIP","fragments":[{"type":"RESPONSE","content":"a"}]}}}',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"b"}',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
      "",
    ].join("\n");

    const parser = new DeepSeekSseParser();
    for (let offset = 0; offset < stream.length; offset += 7) {
      parser.feed(stream.slice(offset, offset + 7));
    }

    expect(parser.result()).toEqual({
      text: "ab",
      thinking: "",
      finished: true,
    });
  });

  test("ignores prototype-polluting path segments", () => {
    const parser = new DeepSeekSseParser();
    try {
      parser.feed(
        [
          'data: {"p":"__proto__/polluted","o":"SET","v":"yes"}',
          'data: {"p":"constructor/prototype/polluted","o":"SET","v":"yes"}',
          'data: {"p":"response/__proto__/polluted","o":"SET","v":"yes"}',
          'data: {"p":"response","o":"SET","v":{"status":"FINISHED","fragments":[{"type":"RESPONSE","content":"safe"}]}}',
          "",
        ].join("\n"),
      );

      expect(parser.result()).toEqual({
        text: "safe",
        thinking: "",
        finished: true,
      });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype.hasOwnProperty("polluted")).toBe(false);
    } finally {
      delete (Object.prototype as Record<string, unknown>).polluted;
    }
  });

  test("appends a path patch that omits the operation", () => {
    const parser = new DeepSeekSseParser();
    parser.feed(
      [
        'data: {"v":{"response":{"fragments":[{"type":"THINK","content":"The"}]}}}',
        'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"#"}]}',
        'data: {"p":"response/fragments/-1/content","v":" deep"}',
        'data: {"v":"seek"}',
        "",
      ].join("\n\n"),
    );

    expect(parser.result()).toEqual({
      text: "# deepseek",
      thinking: "The",
      finished: false,
    });
  });

  test("ignores an unpathed __proto__ key", () => {
    const parser = new DeepSeekSseParser();
    parser.feed(
      'data: {"v":{"__proto__":{"response":{"status":"FINISHED","fragments":[{"type":"RESPONSE","content":"evil"}]}}}}\n\n',
    );

    expect(parser.result()).toEqual({
      text: "",
      thinking: "",
      finished: false,
    });
  });
});
