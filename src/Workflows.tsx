import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type Message } from "./locales";
import ErrorToast from "./ErrorToast";
import { deviceStorageKey, legacyDeviceKeys } from "./deviceAliases";
import PhoneAppPicker from "./PhoneAppPicker";

export type Translate = (key: Message) => string;
export type Device = {
  serial: string;
  model: string;
  connection: "wired" | "wireless";
  status: "online" | "offline" | "unauthorized" | "unavailable";
  session: "idle" | "starting" | "running" | "stopping" | "failed";
  task?: "backgroundRecord" | "audioOnly" | "controlOnly" | "directControl";
};

export const defaultProfile = {
  maxSize: 0, maxFps: 0, bitRate: 0, mute: false, record: false, codec: "",
  audioSource: "", camera: "", display: "", keyboard: "", mouse: "", gamepad: "",
  readOnly: false, top: false, fullscreen: false, screenOff: false, awake: false, forward: false,
};
export type Profile = typeof defaultProfile;

export function loadMap<T>(key: string): Record<string, T> {
  try {
    return Object.assign(Object.create(null) as Record<string, T>, JSON.parse(localStorage.getItem(key) ?? "{}"));
  } catch {
    return Object.create(null) as Record<string, T>;
  }
}

export function errorKey(error: unknown, t: Translate): string {
  return typeof error === "string" && /^[a-zA-Z]+$/.test(error)
    ? t(error as Message) || t("sessionError")
    : t("sessionError");
}

export function ProfileEditor({ profile, update, t }: {
  profile: Profile; update: (profile: Profile) => void; t: Translate;
}) {
  function number(key: "maxSize" | "maxFps" | "bitRate", max: number) {
    return <label className="field"><span>{t(key)}</span><input type="number" min={0} max={max}
      value={profile[key]} onChange={(e) => update({ ...profile, [key]: Number(e.target.value) })} /></label>;
  }
  function toggle(key: "mute" | "record" | "readOnly" | "top" | "fullscreen" | "screenOff" | "awake" | "forward") {
    return <label className="check"><input type="checkbox" checked={profile[key]}
      onChange={(e) => update({ ...profile, [key]: e.target.checked })} />{t(key)}</label>;
  }
  function choice(key: "codec" | "audioSource" | "camera" | "keyboard" | "mouse" | "gamepad",
    options: [string, Message][]) {
    return <label className="field"><span>{t(key)}</span><select value={profile[key]}
      onChange={(e) => update({ ...profile, [key]: e.target.value })}>
      <option value="">{t("defaultOption")}</option>
      {options.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
    </select></label>;
  }
  const inputModes: [string, Message][] = [["sdk", "softwareInput"], ["uhid", "physicalInput"], ["disabled", "disabledOption"]];
  return <>
    <section className="panel controls">
      <h2>{t("quality")}</h2>
      <div className="field-grid" data-tip={t("defaultHint")}>{number("maxSize", 8192)}{number("maxFps", 240)}{number("bitRate", 200)}</div>
      <div className="checks">{toggle("mute")}{toggle("record")}{toggle("top")}</div>
    </section>
    <details className="panel controls">
      <summary data-tip={t("advancedHint")}>{t("advanced")}</summary>
      <div className="field-grid">
        {choice("codec", [["h264", "codecH264"], ["h265", "codecH265"], ["av1", "codecAv1"]])}
        {choice("audioSource", [["output", "systemSound"], ["playback", "appSound"], ["mic", "microphone"]])}
        {choice("camera", [["front", "frontCamera"], ["back", "backCamera"], ["external", "externalCamera"]])}
        <label className="field"><span>{t("display")}</span><input placeholder="1920x1080" value={profile.display}
          onChange={(e) => update({ ...profile, display: e.target.value })} /></label>
        {choice("keyboard", inputModes)}{choice("mouse", inputModes)}{choice("gamepad", inputModes.slice(1))}
      </div>
      <div className="checks">{toggle("readOnly")}{toggle("fullscreen")}{toggle("screenOff")}{toggle("awake")}{toggle("forward")}</div>
    </details>
  </>;
}

const queries = ["displays", "encoders", "apps", "cameras", "cameraSizes", "diagnostics"] as const;
const tasks = ["backgroundRecord", "audioOnly", "controlOnly", "directControl"] as const;

type PhoneApp = { name: string; package: string };
type AppDisplay = { mode: "fixed"; width: number; height: number; wechatInsets?: boolean } | { mode: "follow" };
export type Shortcut = { app: PhoneApp; display: AppDisplay };
export function bindDeviceApps(serial: string, hardware: string, identities: Record<string, string>) {
  const key = `hardware:${hardware}`;
  let changed = false;
  function migrate<T>(storage: string, merge: (legacy: T[]) => T) {
    const data = loadMap<T>(storage);
    const legacy = legacyDeviceKeys(serial, hardware, identities, Object.keys(data))
      .filter((candidate) => Object.prototype.hasOwnProperty.call(data, candidate));
    if (!legacy.length) return;
    const entries = legacy.map((candidate) => data[candidate]);
    if (data[key] !== undefined) entries.unshift(data[key]);
    data[key] = merge(entries);
    for (const candidate of legacy) delete data[candidate];
    localStorage.setItem(storage, JSON.stringify(data));
    changed = true;
  }
  migrate<Shortcut[]>("phone-app-shortcuts", (lists) => {
    const shortcuts = new Map<string, Shortcut>();
    for (const list of lists) {
      for (const shortcut of list) {
        if (!shortcuts.has(shortcut.app.package)) shortcuts.set(shortcut.app.package, shortcut);
      }
    }
    return [...shortcuts.values()];
  });
  migrate<PhoneApp[]>("phone-app-cache", ([apps]) => apps);
  migrate<Record<string, string>>("phone-shortcut-icons", (icons) => Object.assign({}, ...icons.reverse()));
  if (changed) window.dispatchEvent(new Event("device-app-data"));
}

const resolutionPresets = {
  landscape: [1920, 1080],
  portrait: [1080, 1920],
  standard: [1280, 960],
  standardPortrait: [960, 1280],
  square: [1080, 1080],
} as const;

export function AppWindowPanel({ serial, deviceKey, title, screen, t }: {
  serial?: string; deviceKey?: string; title?: string; screen?: [number, number]; t: Translate;
}) {
  const [apps, setApps] = useState(() => deviceKey ? loadMap<PhoneApp[]>("phone-app-cache")[deviceKey] : undefined);
  const [shortcuts, setShortcuts] = useState(() => deviceKey ? loadMap<Shortcut[]>("phone-app-shortcuts")[deviceKey] ?? [] : []);
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState<Shortcut>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [menu, setMenu] = useState<string>();
  const [icons, setIcons] = useState(() => deviceKey ? loadMap<Record<string, string>>("phone-shortcut-icons")[deviceKey] ?? {} : {});
  const iconRequests = useRef(new Set<string>());
  const [mode, setMode] = useState<"fixed" | "follow">("fixed");
  const [width, setWidth] = useState("1080");
  const [height, setHeight] = useState("1920");
  const [preset, setPreset] = useState("nativeResolution");
  const [wechatInsets, setWechatInsets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ key: Message; error: boolean }>();
  const targetApp = editing?.app ?? apps?.find((app) => app.package === selected);
  const screenSize = preset === "halfResolution" ? screen?.map((axis) => Math.round(axis / 2)) : screen;
  const usesScreenSize = preset === "nativeResolution" || preset === "halfResolution";
  const displayWidth = usesScreenSize ? screenSize?.[0]?.toString() ?? "" : width;
  const displayHeight = usesScreenSize ? screenSize?.[1]?.toString() ?? "" : height;
  const validSize = [displayWidth, displayHeight].every((value) => /^\d+$/.test(value) && Number(value) >= 128 && Number(value) <= 8192);
  const canUseWechatInsets = targetApp?.package === "com.tencent.mm" && mode === "fixed" && validSize && Number(displayWidth) < Number(displayHeight);
  const display: AppDisplay = mode === "fixed"
    ? { mode, width: Number(displayWidth), height: Number(displayHeight), wechatInsets: canUseWechatInsets && wechatInsets }
    : { mode };

  useEffect(() => {
    if (!deviceKey) return;
    const sync = () => {
      setApps(loadMap<PhoneApp[]>("phone-app-cache")[deviceKey]);
      setShortcuts(loadMap<Shortcut[]>("phone-app-shortcuts")[deviceKey] ?? []);
      setIcons(loadMap<Record<string, string>>("phone-shortcut-icons")[deviceKey] ?? {});
    };
    window.addEventListener("device-app-data", sync);
    return () => window.removeEventListener("device-app-data", sync);
  }, [deviceKey]);

  useEffect(() => {
    if (!serial) return;
    for (const { app } of shortcuts) {
      if (icons[app.package] || iconRequests.current.has(app.package)) continue;
      iconRequests.current.add(app.package);
      void invoke<string>("app_icon", { serial, package: app.package }).then((icon) => {
        const cache = loadMap<Record<string, string>>("phone-shortcut-icons");
        const key = deviceStorageKey(serial, loadMap<string>("device-identities"));
        cache[key] = { ...cache[key], [app.package]: icon };
        setIcons(cache[key]);
        try { localStorage.setItem("phone-shortcut-icons", JSON.stringify(cache)); } catch { /* 本次仍可显示图标。 */ }
      }).catch(() => {});
    }
  }, [serial, shortcuts, icons]);

  useEffect(() => {
    if (!menu) return;
    function dismiss(event: PointerEvent) {
      if (!(event.target as Element).closest(".shortcut-menu")) setMenu(undefined);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menu]);

  async function loadApps() {
    if (!serial || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const entries = await invoke<PhoneApp[]>("list_apps", { serial });
      const cache = loadMap<PhoneApp[]>("phone-app-cache");
      cache[deviceStorageKey(serial, loadMap<string>("device-identities"))] = entries;
      localStorage.setItem("phone-app-cache", JSON.stringify(cache));
      setApps(entries);
      if (!entries.some((app) => app.package === selected)) setSelected("");
    } catch (error) {
      setMessage({ key: typeof error === "string" && t(error as Message) ? error as Message : "queryFailed", error: true });
    } finally {
      setBusy(false);
    }
  }

  async function openApp(app: PhoneApp, options: AppDisplay) {
    if (!serial || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await invoke("open_app_window", {
        serial, package: app.package, title: `${app.name || app.package} · ${title ?? serial}`,
        display: options,
      });
      setMessage({ key: "appWindowOpened", error: false });
    } catch (error) {
      setMessage({ key: typeof error === "string" && t(error as Message) ? error as Message : "appWindowFailed", error: true });
    } finally {
      setBusy(false);
    }
  }

  function applyPreset(value: string) {
    setPreset(value);
    setMessage(undefined);
    if (value === "customResolution") {
      setWidth(displayWidth);
      setHeight(displayHeight);
      return;
    }
    const dimensions = resolutionPresets[value as keyof typeof resolutionPresets];
    if (dimensions) {
      setWidth(String(dimensions[0]));
      setHeight(String(dimensions[1]));
    }
  }

  function editShortcut(shortcut: Shortcut) {
    setMenu(undefined);
    setEditorOpen(true);
    setEditing(shortcut);
    setSelected(shortcut.app.package);
    setMode(shortcut.display.mode);
    setWechatInsets(shortcut.display.mode === "fixed" && (shortcut.display.wechatInsets ?? false));
    setPreset("customResolution");
    if (shortcut.display.mode === "fixed") {
      setWidth(String(shortcut.display.width));
      setHeight(String(shortcut.display.height));
    }
    setMessage(undefined);
  }

  function saveShortcuts(next: Shortcut[]) {
    if (!serial) return;
    const saved = loadMap<Shortcut[]>("phone-app-shortcuts");
    saved[deviceStorageKey(serial, loadMap<string>("device-identities"))] = next;
    localStorage.setItem("phone-app-shortcuts", JSON.stringify(saved));
    setShortcuts(next);
    setEditing(undefined);
    setEditorOpen(false);
    setMenu(undefined);
  }

  return <>
    <div className="shortcut-list app-grid" onKeyDown={(event) => { if (event.key === "Escape") setMenu(undefined); }}>
      {shortcuts.map((shortcut) => <div className="shortcut-tile" key={shortcut.app.package}>
        <button type="button"
        className="icon-button shortcut" disabled={busy || !serial}
        aria-label={shortcut.app.name || shortcut.app.package} data-tip={`${shortcut.app.name || shortcut.app.package} · ${t("shortcutHint")}`}
        onClick={() => { setMenu(undefined); void openApp(shortcut.app, shortcut.display); }}
        onContextMenu={(event) => { event.preventDefault(); setMenu(shortcut.app.package); }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault(); setMenu(shortcut.app.package);
          }
        }}>
          {icons[shortcut.app.package]
            ? <img src={icons[shortcut.app.package]} alt="" draggable={false} />
            : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /></svg>}
        </button>
        {menu === shortcut.app.package && <div className="shortcut-menu panel">
          <button type="button" onClick={() => editShortcut(shortcut)}>{t("editShortcut")}</button>
          <button type="button" onClick={() => saveShortcuts(shortcuts.filter((entry) => entry.app.package !== shortcut.app.package))}>{t("removeShortcut")}</button>
        </div>}
      </div>)}
      <button type="button" className="icon-button shortcut shortcut-add" disabled={!serial || busy}
        aria-label={t("pinShortcut")} data-tip={t("pinShortcut")} onClick={() => {
          setMenu(undefined); setEditing(undefined); setSelected(""); setMessage(undefined);
          setMode("fixed"); setPreset("nativeResolution"); setWechatInsets(false);
          setEditorOpen(true);
          if (!apps) void loadApps();
        }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
    </div>
    <ErrorToast message={message?.error ? t(message.key) : undefined} dismiss={t("dismissNotice")} />
  {editorOpen && <section className="panel controls shortcut-editor"
    role="dialog" aria-label={t(editing ? "editingShortcut" : "pinShortcut")}
    onKeyDown={(event) => { if (event.key === "Escape") { setEditing(undefined); setEditorOpen(false); } }}>
    <h2>{t(editing ? "editingShortcut" : "pinShortcut")}</h2>
    <div className="tool-row app-picker-row">
      <PhoneAppPicker apps={apps} selected={targetApp} disabled={busy} readOnly={!!editing} t={t}
        onSelect={(value) => { setSelected(value); setMessage(undefined); }} />
      <button type="button" disabled={busy || !serial} onClick={() => void loadApps()}>{t(apps ? "refreshPhoneApps" : "loadPhoneApps")}</button>
    </div>
    <div className="field-grid app-display-options">
      <label className="field" data-tip={t(mode === "follow" ? "appFollowHint" : "appFixedHint")}><span>{t("appDisplayMode")}</span>
        <select value={mode} disabled={busy} onChange={(event) => {
          setMode(event.target.value as typeof mode);
          setMessage(undefined);
        }}>
          <option value="fixed">{t("appFixedResolution")}</option>
          <option value="follow">{t("appFollowWindow")}</option>
        </select>
      </label>
      {mode === "fixed" && <>
        <label className="field"><span>{t("resolutionPreset")}</span>
          <select value={preset} disabled={busy} onChange={(event) => applyPreset(event.target.value)}>
            <option value="customResolution">{t("customResolution")}</option>
            <option value="nativeResolution" disabled={!screen}>{t("nativeResolution")}{screen ? ` · ${screen.join("×")}` : ""}</option>
            <option value="halfResolution" disabled={!screen}>{t("halfResolution")}</option>
            {Object.entries(resolutionPresets).map(([key, size]) => <option key={key} value={key}>
              {t(key as keyof typeof resolutionPresets)} · {size.join("×")}
            </option>)}
          </select>
        </label>
        <label className="field"><span>{t("appDisplayWidth")}</span>
          <input type="number" min={128} max={8192} value={displayWidth} disabled={busy}
            data-tip={!validSize ? t("invalidAppResolution") : undefined}
            onChange={(event) => { setWidth(event.target.value); setHeight(displayHeight); setPreset("customResolution"); setMessage(undefined); }} />
        </label>
        <label className="field"><span>{t("appDisplayHeight")}</span>
          <input type="number" min={128} max={8192} value={displayHeight} disabled={busy}
            data-tip={!validSize ? t("invalidAppResolution") : undefined}
            onChange={(event) => { setWidth(displayWidth); setHeight(event.target.value); setPreset("customResolution"); setMessage(undefined); }} />
        </label>
      </>}
    </div>
    {canUseWechatInsets && <label className="check" data-tip={t("wechatInsetsHint")}>
      <input type="checkbox" checked={wechatInsets} disabled={busy}
        onChange={(event) => setWechatInsets(event.target.checked)} />
      {t("wechatInsets")}
    </label>}
    <div className="form-actions">
      <button type="button" onClick={() => { setEditing(undefined); setEditorOpen(false); }}>{t("cancel")}</button>
      <button type="button" className="primary-action" disabled={busy || !targetApp || !serial || (mode === "fixed" && !validSize)}
        onClick={() => {
          if (!targetApp) return;
          const next = { app: targetApp, display };
          saveShortcuts(shortcuts.some((shortcut) => shortcut.app.package === targetApp.package)
            ? shortcuts.map((shortcut) => shortcut.app.package === targetApp.package ? next : shortcut)
            : [...shortcuts, next]);
        }}>{t("save")}</button>
    </div>
    {busy && <p role="status">{t("working")}</p>}
    {message && !message.error && <p role="status">{t(message.key)}</p>}
  </section>}</>;
}

export function ToolPanel({ device, t, refresh }: { device?: Device; t: Translate; refresh: () => Promise<void> | null }) {
  const [query, setQuery] = useState<typeof queries[number]>("displays");
  const [task, setTask] = useState<typeof tasks[number]>("backgroundRecord");
  const [seconds, setSeconds] = useState(15);
  const [directSerial, setDirectSerial] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ serial: string; text?: string; message?: Message; error?: unknown }>();

  async function run(kind: "query" | "task") {
    const serial = kind === "task" && task === "directControl"
      ? directSerial.trim() || (device?.connection === "wired" ? device.serial : "")
      : device?.serial;
    if (!serial || busy) return;
    setBusy(true);
    setResult(undefined);
    try {
      if (kind === "query") {
        const output = await invoke<{ text: string; success: boolean }>("query_device", { serial, query });
        setResult({ serial, text: output.text, error: output.success ? undefined : "queryFailed" });
      } else {
        const text = await invoke<string | null>("run_tool", { serial, task, seconds });
        setResult({ serial, text: text ?? undefined, message: "taskStarted" });
        await refresh();
      }
    } catch (error) {
      setResult({ serial, error });
    } finally {
      setBusy(false);
    }
  }

  const wiredSerial = directSerial.trim() || (device?.connection === "wired" ? device.serial : "");
  const activeResult = result && (result.serial === device?.serial ||
    (task === "directControl" && result.serial === wiredSerial)) ? result : undefined;
  const sessionActive = device?.session === "running" || device?.session === "starting" || device?.session === "stopping";
  return <>
    <section className="panel controls">
      <h2>{t("queryTitle")}</h2>
      <div className="tool-row">
        <label className="field"><span>{t("queryType")}</span><select value={query}
          onChange={(e) => setQuery(e.target.value as typeof query)}>
          {queries.map((entry) => <option key={entry} value={entry}>{t(entry)}</option>)}
        </select></label>
        <button type="button" disabled={busy || device?.status !== "online"} onClick={() => void run("query")}>{t("queryRun")}</button>
      </div>
    </section>
    <section className="panel controls">
      <h2>{t("standaloneTasks")}</h2>
      <div className="tool-row">
        <label className="field"><span>{t("taskType")}</span><select value={task}
          onChange={(e) => setTask(e.target.value as typeof task)}>
          {tasks.map((entry) => <option key={entry} value={entry}>{t(entry)}</option>)}
        </select></label>
        {task !== "directControl" && <label className="field duration"><span>{t("duration")}</span>
          <input type="number" value={seconds} min={3} max={300} onChange={(e) => setSeconds(Number(e.target.value))} /></label>}
        {task === "directControl" && <label className="field"><span>{t("wiredSerial")}</span>
          <input value={directSerial} placeholder={device?.connection === "wired" ? device.serial : undefined}
            maxLength={128} onChange={(e) => setDirectSerial(e.target.value)} /></label>}
        <button type="button" disabled={busy || (task === "directControl"
          ? !wiredSerial || (sessionActive && wiredSerial === device?.serial)
          : sessionActive || device?.status !== "online" || !Number.isInteger(seconds) || seconds < 3 || seconds > 300)}
          onClick={() => void run("task")}>{t("taskRun")}</button>
      </div>
      <p>{t(task === "backgroundRecord" ? "backgroundHint" : task === "directControl" ? "directHint" : "taskHint")}</p>
      {sessionActive && <p>{t("taskBusy")}</p>}
    </section>
    {busy && <p role="status">{t("working")}</p>}
    <ErrorToast message={activeResult?.error === undefined ? undefined : errorKey(activeResult.error, t)} dismiss={t("dismissNotice")} />
    {activeResult && (activeResult.message || activeResult.text !== undefined) && <div className="panel controls" aria-live="polite">
      {activeResult.message && <p>{t(activeResult.message)}</p>}
      {activeResult.text !== undefined && <pre>{activeResult.text || t("noResult")}</pre>}
    </div>}
  </>;
}
