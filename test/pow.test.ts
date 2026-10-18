import { describe, expect, test } from "bun:test";
import { PowError, solvePow } from "../src/deepseek/pow";

describe("solvePow", () => {
  test("finds the known DeepSeekHashV1 answer", () => {
    const answer = solvePow({
      challenge: "39f83c0fc61fe0eff53fcd7a1f5276942fd18d146d92a0a45d9b6643419a29d6",
      salt: "f5ffa87745b8eb2b56d4",
      expire_at: 1792251384408,
      difficulty: 144000,
    });
    expect(answer).toBe(71319);
  });

  test("throws PowError when no nonce matches", () => {
    expect(() =>
      solvePow({
        challenge: "39f83c0fc61fe0eff53fcd7a1f5276942fd18d146d92a0a45d9b6643419a29d6",
        salt: "f5ffa87745b8eb2b56d4",
        expire_at: 1792251384408,
        difficulty: 1,
      }),
    ).toThrow(PowError);
  });
});
