import { expect, it } from "vitest";
import { routineReportVisible } from "./routine-delivery.ts";

it("keeps conditional progress and intentional no-report out of chat, while reports and failures stay visible", () => {
  for (const status of ["queued", "running", "waiting", "cancelled"] as const) {
    expect(routineReportVisible({ delivery: "conditional", status })).toBe(false);
    expect(routineReportVisible({ status })).toBe(true);
  }
  expect(routineReportVisible({ delivery: "conditional", status: "completed", reportOutcome: "no-report" })).toBe(false);
  expect(routineReportVisible({ delivery: "conditional", status: "completed", reportOutcome: "report" })).toBe(true);
  expect(routineReportVisible({ delivery: "conditional", status: "failed", reportOutcome: "no-report" })).toBe(true);
  expect(routineReportVisible({ delivery: "conditional", status: "missed" })).toBe(true);
});
