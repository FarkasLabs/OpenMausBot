import type { RoutineDelivery } from "../../../shared/routine-delivery.ts";
import { t } from "@/lib/i18n";

export function RoutineDeliveryControl({ value, onChange }: {
  value: RoutineDelivery;
  onChange: (value: RoutineDelivery) => void;
}) {
  return <label className="block space-y-1.5 text-[12px] text-ink">
    <span>{t("routines.delivery.label")}</span>
    <select aria-label={t("routines.delivery.label")} value={value} onChange={event => onChange(event.target.value === "conditional" ? "conditional" : "always")} className="block w-full rounded-lg border border-hairline/50 bg-panel px-3 py-2 outline-none focus:border-accent">
      <option value="always">{t("routines.delivery.always")}</option>
      <option value="conditional">{t("routines.delivery.conditional")}</option>
    </select>
    {value === "conditional" && <span className="block text-[11px] leading-relaxed text-ink-secondary">{t("routines.delivery.help")}</span>}
  </label>;
}
