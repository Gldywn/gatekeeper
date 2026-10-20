import { describe, expect, it } from "vitest";
import { thumbBox } from "./overlay-scroll";

describe("thumbBox", () => {
  it("shows nothing when the content fits", () => {
    expect(thumbBox(300, 300, 0, 296)).toBeNull();
    expect(thumbBox(300, 301, 0, 296)).toBeNull();
  });

  it("sizes the thumb to the visible share and places it along the room left", () => {
    // A third visible: a third of the track; halfway down the range: halfway down the room.
    const box = thumbBox(300, 900, 300, 300);
    expect(box?.size).toBe(100);
    expect(box?.at).toBe(100);
    expect(box?.ratio).toBe(3);
    expect(thumbBox(300, 900, 600, 300)?.at).toBe(200);
  });

  it("keeps a long list's thumb grabbable and inside the track", () => {
    const box = thumbBox(300, 100_000, 99_700, 296);
    expect(box?.size).toBe(24);
    expect(box?.at).toBe(272);
    expect(thumbBox(300, 900, 5_000, 300)?.at).toBe(200);
  });
});
