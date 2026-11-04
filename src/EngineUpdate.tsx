import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ErrorToast from "./ErrorToast";
import { errorKey, type Translate } from "./Workflows";

type Status = { current: string | null; pending: boolean; rollback: boolean; managed: boolean };

function newer(latest: string, current: string | null) {
  if (!current) return true;
  const left = latest.split(".").map(Number);
  const right = current.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}

export default function EngineUpdate({ visible, t }: { visible: boolean; t: Translate }) {
  const [status, setStatus] = useState<Status>();
  const [latest, setLatest] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  const refresh = useCallback(async () => {
    setStatus(await invoke<Status>("engine_status"));
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    setFailure(undefined);
    try {
      await refresh();
      setLatest(await invoke<string>("check_engine_update"));
    } catch (error) {
      setLatest(undefined);
      setFailure(error);
    } finally {
      setChecking(false);
    }
  }, [refresh]);

  useEffect(() => {
    const first = window.setTimeout(() => void check(), 500);
    const interval = window.setInterval(() => void check(), 6 * 60 * 60 * 1000);
    return () => { window.clearTimeout(first); window.clearInterval(interval); };
  }, [check]);

  useEffect(() => {
    if (!status?.pending) return;
    const interval = window.setInterval(() => {
      void refresh().catch(setFailure);
    }, 2000);
    return () => window.clearInterval(interval);
  }, [refresh, status?.pending]);

  async function change(rollback: boolean) {
    setBusy(true);
    setFailure(undefined);
    try {
      if (rollback) await invoke("rollback_engine");
      else await invoke("install_engine_update", { requested: latest });
      await refresh();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;
  const available = status && latest && newer(latest, status.current);
  const notice = status && !status.managed ? "engineExternal"
    : status?.pending ? "engineWaiting"
    : busy ? "working"
    : checking ? "engineChecking"
    : latest && status && !available ? "engineUpToDate" : undefined;
  return <section className="panel controls engine-update">
    <h2>{t("engineUpdates")}</h2>
    <p>{t("engineCurrentVersion")} · {status?.current ?? t("engineVersionUnknown")}</p>
    <p>{t("engineLatestVersion")} · {latest ?? t("engineVersionUnknown")}</p>
    {notice && <p role="status">{t(notice)}</p>}
    <ErrorToast message={failure === undefined ? undefined : errorKey(failure, t)} dismiss={t("dismissNotice")} />
    <div className="tool-row">
      <button type="button" disabled={checking || busy} onClick={() => void check()}>{t("engineCheckAction")}</button>
      {available && status.managed && <button type="button" disabled={busy || checking || status.pending}
        onClick={() => void change(false)}>{t("engineInstallAction")}</button>}
      {status?.rollback && <button type="button" disabled={busy || status.pending}
        onClick={() => void change(true)}>{t("engineRollbackAction")}</button>}
    </div>
  </section>;
}
