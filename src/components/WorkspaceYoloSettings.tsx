import { useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { t } from "@/lib/i18n";
import { Card, Switch } from "./SettingsPrimitives";
import { FullAccessWarning } from "./FullAccessWarning";

export function WorkspaceYoloSettings() {
  const { state, dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const enabled = state.config?.yolo === true;
  const [warning, setWarning] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const save = async (next: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    setWarning(false);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config/yolo", {
        method: "PUT", body: JSON.stringify({ enabled: next, confirmed: next }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.yolo.error"));
    } finally {
      saving.current = false;
      setPending(false);
    }
  };
  return (
    <Card title={t("settings.yolo.title")} subtitle={t("settings.yolo.subtitle")}>
      <div className="flex items-start justify-between gap-4">
        <p className="text-[13px] leading-relaxed text-ink-secondary">
          {t(enabled ? "settings.yolo.on" : "settings.yolo.off")}
        </p>
        <Switch checked={enabled} aria-label={t("settings.yolo.title")} disabled={pending || ownerOrAdmin !== true}
          onClick={() => enabled ? void save(false) : setWarning(true)} />
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{t("settings.yolo.help")}</p>
      {pending && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("settings.yolo.saving")}</p>}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      <FullAccessWarning open={warning} mode="yolo" scope="workspace" onCancel={() => setWarning(false)} onConfirm={() => void save(true)} />
    </Card>
  );
}
