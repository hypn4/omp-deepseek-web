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
});
