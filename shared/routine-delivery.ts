import type { RoutineRun } from "./routines.ts";

export type RoutineDelivery = "always" | "conditional";
export type RoutineReportOutcome = "report" | "no-report";

export const ROUTINE_NO_REPORT = '{"routine_result":"no_report"}';

export const CONDITIONAL_ROUTINE_PROMPT = `This is a silent, conditional routine. Only report when the configured reporting condition is met. If the check succeeded and nothing needs reporting, your entire final response must be exactly ${ROUTINE_NO_REPORT}, with no code fence, explanation or other text. Otherwise return the meaningful report as your final response. Never use the no-report result for errors, blocked work, denied permissions or incomplete checks. Do not send routine status, acknowledgements or no-change messages through messaging tools. Normal permission checks still apply.`;

export function routineReportVisible(run: Pick<RoutineRun, "delivery" | "status" | "reportOutcome">): boolean {
  if (run.delivery !== "conditional") return true;
  return run.status === "failed" || run.status === "missed" ||
    (run.status === "completed" && run.reportOutcome !== "no-report");
}
