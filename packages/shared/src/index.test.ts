import { describe, expect, it } from "vitest";
import { readBoundedText } from "./index";
describe("bounded input reading", () => {
  it("enforces byte limits on streamed UTF-8", async () => {
    await expect(readBoundedText(new Response("🌄🌄").body, 7)).rejects.toThrow("BODY_TOO_LARGE");
    await expect(readBoundedText(new Response("Sherpa").body, 6)).resolves.toBe("Sherpa");
  });
});
