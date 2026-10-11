import { z } from "zod";
import type { RequestAuth } from "./request-auth.ts";

export const yoloChangeSchema = z.object({
  enabled: z.boolean(),
  confirmed: z.boolean().optional(),
}).strict().refine(value => !value.enabled || value.confirmed === true, {
  message: "Confirm the YOLO warning before enabling it",
});

/** Loopback alone is also a bot's shell, not proof of a person's consent.
 * Desktop mutations have already passed the private capability check. */
export function canConfigureYolo(auth: RequestAuth, desktopManaged: boolean): boolean {
  return auth.scopes.includes("admin") && (auth.kind === "session" ||
    (desktopManaged && auth.kind === "loopback" && auth.trust !== "service"));
}
