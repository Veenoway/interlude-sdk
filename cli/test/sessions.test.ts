import { describe, expect, it } from "vitest";
import { controlUrl, DEFAULT_CONTROL_URL } from "../src/ship.js";

describe("interlude sessions", () => {
  it("talks to the public control plane by default", () => {
    const previous = process.env.INTERLUDE_CONTROL_URL;
    delete process.env.INTERLUDE_CONTROL_URL;
    try {
      expect(controlUrl([])).toBe(DEFAULT_CONTROL_URL);
    } finally {
      if (previous === undefined) delete process.env.INTERLUDE_CONTROL_URL;
      else process.env.INTERLUDE_CONTROL_URL = previous;
    }
  });
});
