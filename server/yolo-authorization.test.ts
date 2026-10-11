import { describe, expect, it } from "vitest";
import type { SessionRecord } from "./sessions.ts";
import { canConfigureYolo, yoloChangeSchema } from "./yolo-authorization.ts";
import { requiredScope } from "./request-auth.ts";

describe("human YOLO configuration authority", () => {
  it("refuses bare loopback even when its legacy authority includes admin", () => {
    expect(canConfigureYolo({ kind: "loopback", scopes: ["admin", "client"] }, false)).toBe(false);
    expect(canConfigureYolo({ kind: "loopback", scopes: ["client"], trust: "service" }, true)).toBe(false);
    expect(canConfigureYolo({ kind: "loopback", scopes: ["admin", "client"] }, true)).toBe(true);
  });

  it("accepts authenticated admins but not chat-only sessions", () => {
    const session: SessionRecord = { id: "fixture", tokenHash: "0".repeat(64), label: "Fixture admin", scopes: ["admin", "client"], createdAt: 0, lastSeenAt: 0, expiresAt: 1000 };
    expect(canConfigureYolo({ kind: "session", session, via: "bearer", scopes: session.scopes }, false)).toBe(true);
    expect(canConfigureYolo({ kind: "session", session, via: "cookie", scopes: ["client"] }, false)).toBe(false);
    expect(requiredScope("PUT", "/api/config/yolo")).toBe("admin");
    expect(requiredScope("PUT", "/api/bots/bot-fixture/yolo")).toBe("admin");
  });

  it("requires explicit confirmation to enable, not to disable", () => {
    expect(yoloChangeSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(yoloChangeSchema.safeParse({ enabled: true, confirmed: false }).success).toBe(false);
    expect(yoloChangeSchema.parse({ enabled: true, confirmed: true })).toEqual({ enabled: true, confirmed: true });
    expect(yoloChangeSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(yoloChangeSchema.safeParse({ enabled: "true", confirmed: true }).success).toBe(false);
    expect(yoloChangeSchema.safeParse({ enabled: true, confirmed: true, for_bot_id: "other" }).success).toBe(false);
  });
});
