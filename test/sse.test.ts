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
      messageId: 2,
    });
  });

  test("does not let a title event overwrite a rate-limit hint", () => {
    const parser = new DeepSeekSseParser();
    parser.feed(
      [
        "event: ready",
        'data: {"request_message_id":1,"response_message_id":2}',
        "",
        "event: hint",
        'data: {"type":"error","content":"Messages too frequent. Try again later.","finish_reason":"rate_limit_reached"}',
        "",
        "event: title",
        'data: {"content":"앱 인증 방식 분석"}',
        "",
        "event: close",
        'data: {"click_behavior":"retry","auto_resume":false}',
        "",
      ].join("\n"),
    );

    expect(parser.result()).toMatchObject({
      errorType: "error",
      errorMessage: "Messages too frequent. Try again later.",
      finishReason: "rate_limit_reached",
      finished: true,
    });
  });

  test("uses the response message id when ready metadata is absent", () => {
    const parser = new DeepSeekSseParser();
    parser.feed(
      [
        'data: {"v":{"response":{"message_id":42,"status":"WIP","fragments":[]}}}',
        "",
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
        "",
      ].join("\n"),
    );
    expect(parser.result().messageId).toBe(42);
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

  test("appends a fragment array when the operation is omitted", () => {
    const parser = new DeepSeekSseParser();
    parser.feed(
      [
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"answer"}]}}}',
        'data: {"p":"response/fragments","v":[{"type":"TIP","content":"footer"}]}',
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
        "",
      ].join("\n"),
    );

    expect(parser.result()).toMatchObject({
      text: "answer",
      finished: true,
    });
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

  test("extracts the web-search status", () => {
    const parser = new DeepSeekSseParser();
    parser.feed(
      'data: {"v":{"response":{"search_status":"SEARCHING","fragments":[]}}}\n\n',
    );

    expect(parser.result()).toEqual({
      text: "",
      thinking: "",
      finished: false,
      searchStatus: "SEARCHING",
    });
  });

  test("extracts context_length_exceeded hint errors", () => {
    const parser = new DeepSeekSseParser();
    parser.feed(
      [
        'event: ready',
        'data: {"request_message_id":1,"response_message_id":2}',
        '',
        'event: hint',
        'data: {"type":"error","content":"Length limit reached. Please start a new chat.","clear_response":true,"finish_reason":"context_length_exceeded"}',
        '',
        'event: close',
        'data: {"click_behavior":"none","auto_resume":false}',
        '',
      ].join("\n"),
    );

    expect(parser.result()).toMatchObject({
      finished: true,
      finishReason: "context_length_exceeded",
      errorType: "error",
      errorMessage: "Length limit reached. Please start a new chat.",
    });
  });

  test("extracts native incomplete and finish metadata", () => {
    const parser = new DeepSeekSseParser();
    parser.feed(
      [
        'data: {"v":{"response":{"status":"FINISHED","fragments":[{"type":"RESPONSE","content":"partial"},{"type":"HINT","finish_reason":"length"}],"incomplete_message":"","has_pending_fragment":false}}}',
        "",
      ].join("\n"),
    );

    expect(parser.result()).toMatchObject({
      text: "partial",
      finished: true,
      incompleteMessage: "",
      hasPendingFragment: false,
      finishReason: "length",
    });
  });

  test("derives searching and composing from search fragments", () => {
    const parser = new DeepSeekSseParser();
    parser.feed(
      'data: {"v":{"response":{"fragments":[{"type":"TOOL_SEARCH","content":null,"queries":[]}]}}}\n\n',
    );
    expect(parser.result().searchStatus).toBe("searching");

    parser.feed(
      'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"answer"}]}\n\n',
    );
    expect(parser.result()).toMatchObject({
      text: "answer",
      searchStatus: "composing",
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
