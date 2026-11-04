import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorKey, type Translate } from "./Workflows";
import ErrorToast from "./ErrorToast";

const modes = ["wired", "pairMode", "connectMode"] as const;
type Mode = typeof modes[number];

export default function ConnectionDialog({ t, onClose, refresh, restoreEntries, onRestore }: {
  t: Translate;
  onClose: () => void;
  refresh: () => Promise<void> | null;
  restoreEntries: { serial: string; model: string }[];
  onRestore: (serial: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<Mode>("wired");
  const [pairAddress, setPairAddress] = useState("");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || mode === "wired") return;
    setBusy(true);
    setFailure(undefined);
    try {
      if (mode === "pairMode") {
        const pairingCode = code;
        setCode("");
        setPaired(false);
        await invoke("pair_wireless", { address: pairAddress, code: pairingCode });
        setPaired(true);
        await refresh();
      } else {
        const connected = await invoke<string>("connect_wireless", { target: address, savedAddress: null });
        onRestore(connected);
        await refresh();
        onClose();
      }
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="panel controls connection-dialog" aria-label={t("addDevice")}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2>{t("addDevice")}</h2>
    <nav className="connection-modes" aria-label={t("connectionMethods")}>
      {modes.map((entry) => <button key={entry} type="button" aria-pressed={entry === mode} disabled={busy}
        onClick={() => { setMode(entry); setFailure(undefined); setCode(""); }}>{t(entry === "wired" ? "wiredMode" : entry)}</button>)}
    </nav>
    <form onSubmit={(event) => void submit(event)}>
      {mode === "wired" && <p>{t("wiredInstructions")}</p>}
      {mode === "wired" && restoreEntries.length > 0 && <section className="restore-devices">
        <h2>{t("restoreDetectedDevices")}</h2>
        {restoreEntries.map((entry) => <div key={entry.serial}>
          <span>{entry.model} · {entry.serial}</span>
          <button type="button" onClick={() => onRestore(entry.serial)}>{t("restoreDevice")}</button>
        </div>)}
      </section>}
      {mode === "pairMode" && <>
        <label className="field" data-tip={t("pairAddressHint")}><span>{t("pairAddress")}</span>
          <input value={pairAddress} onChange={(event) => setPairAddress(event.target.value)}
            placeholder="192.168.1.20:37001" required disabled={busy} spellCheck={false} /></label>
        <label className="field"><span>{t("pairCode")}</span>
          <input type="password" inputMode="numeric" autoComplete="off" maxLength={6} pattern="[0-9]{6}"
            value={code} onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ""))}
            required disabled={busy} /></label>
      </>}
      {mode === "connectMode" && <label className="field" data-tip={t("connectAddressHint")}><span>{t("connectAddress")}</span>
        <input value={address} onChange={(event) => setAddress(event.target.value)}
          placeholder="192.168.1.20:5555" required disabled={busy} spellCheck={false} /></label>}
      {paired && mode === "pairMode" && <p role="status">{t("pairComplete")}</p>}
      <ErrorToast message={failure === undefined ? undefined : errorKey(failure, t)} dismiss={t("dismissNotice")} />
      {busy && <p role="status">{t("working")}</p>}
      <div className="form-actions">
        <button type="button" disabled={busy} onClick={onClose}>{t("cancel")}</button>
        {paired && mode === "pairMode" && <button type="button" disabled={busy} onClick={() => { setMode("connectMode"); setFailure(undefined); }}>
          {t("connectMode")}</button>}
        {mode !== "wired" && <button type="submit" className="primary-action" disabled={busy || (mode === "pairMode" ? !pairAddress.trim() || code.length !== 6 : !address.trim())}>
          {t(mode === "pairMode" ? "pairAction" : "connectAction")}</button>}
      </div>
    </form>
  </dialog>;
}
