import { Plus, LayoutGrid } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { AudioLines, Camera, FolderUp, ScanSearch, SlidersHorizontal, Video } from "lucide-react";
import { type Message } from "./locales";
import ErrorToast from "./ErrorToast";
import { legacyDeviceKeys, preserveUnboundRecord } from "./deviceAliases";
import PhoneAppPicker from "./PhoneAppPicker";
import { saveLocalStorage } from "./localStorage";

export type Translate = (key: Message) => string;
export type Device = {
  serial: string;
  hardware?: string | null;
  transportId?: string | null;
  model: string;
  connection: "wired" | "wireless";
  status: "online" | "offline" | "unauthorized" | "unavailable";
  session: "idle" | "starting" | "running" | "stopping" | "failed";
  task?: "backgroundRecord" | "audioRecord" | "audioOnly" | "controlOnly" | "directControl";
};

export const defaultProfile = {
  maxSize: 0, maxFps: 0, bitRate: 0, mute: true, record: false, codec: "",
  audioMode: "", audioCodec: "", audioBitRate: 0, audioBuffer: 0, audioEncoder: "",
  videoBuffer: 0, crop: "", captureOrientation: "", videoEncoder: "",
  recordFormat: "mkv", recordFolder: "", recordSeconds: 0,
  noClipboardSync: false, legacyPaste: false, pushTarget: "",
  startupX: null as number | null, startupY: null as number | null,
  startupWidth: null as number | null, startupHeight: null as number | null, extraArgs: [] as string[],
  cameraId: "", cameraSize: "", cameraFps: 0, cameraHighSpeed: false, cameraTorch: false, cameraZoom: "",
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

export type ProfileSection = "quality" | "audioOutput" | "recordingSettings" | "windowBehavior" | "advanced" | "clipboardFiles";

type RememberedPlacement = { x: number; y: number; width: number; height: number };
const placementRows = [
  ["startupPosition", [["startupX", "x", -2147483648, 2147483647], ["startupY", "y", -2147483648, 2147483647]]],
  ["startupSize", [["startupWidth", "width", 160, 16384], ["startupHeight", "height", 310, 16384]]],
] as const;

function StartupGeometryField({ label, value, remembered, min, max, hint, error, update }: {
  label: string; value: number | null; remembered?: number;
  min: number; max: number; hint: string; error: string; update: (value: number | null) => void;
}) {
  const shown = String(value ?? remembered ?? "");
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const trimmed = draft.trim();
  const number = Number(trimmed);
  const valid = !trimmed || (/^-?\d+$/.test(trimmed) && Number.isInteger(number) && number >= min && number <= max);
  function commit() {
    if (trimmed === shown || !valid) return;
    const next = trimmed ? number : null;
    setDraft(String(next ?? remembered ?? ""));
    update(next);
  }
  return <label className="field" data-tip={valid ? hint : error}>
    <span>{label}</span>
    <input type="text" inputMode={min < 0 ? "text" : "numeric"} placeholder="—" value={draft}
      aria-invalid={!valid}
      onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          commit();
        }
      }} />
  </label>;
}

function StartupGeometry({ serial, hardware, profile, update, t }: {
  serial: string; hardware?: string; profile: Profile; update: (profile: Profile) => void; t: Translate;
}) {
  const [remembered, setRemembered] = useState<RememberedPlacement>();
  useEffect(() => {
    let active = true;
    setRemembered(undefined);
    const identities = loadMap<string>("device-identities");
    const expectedHardware = hardware ?? identities[serial];
    if (!expectedHardware) return;
    const legacySerials = Object.keys(identities).filter((endpoint) => identities[endpoint] === expectedHardware);
    void invoke<RememberedPlacement | null>("last_mirror_placement", { serial, hardware: expectedHardware, legacySerials })
      .then((placement) => { if (active) setRemembered(placement ?? undefined); }).catch(() => {});
    return () => { active = false; };
  }, [serial, hardware]);
  return <div className="device-settings-subsection settings-stack">
    <h3>{t("startupGeometry")}</h3>
    {placementRows.map(([group, fields]) => <fieldset className="startup-geometry-row" key={group}>
      <legend>{t(group)}</legend>
      <div className="field-grid">
        {fields.map(([key, rememberedKey, min, max]) => <StartupGeometryField key={key}
          label={t(key)} value={profile[key]} remembered={remembered?.[rememberedKey]} min={min} max={max}
          hint={t(group === "startupSize" ? "startupSizeHint" : "startupGeometryHint")} error={t("invalidStartupPlacement")}
          update={(value) => { if (value !== profile[key]) update({ ...profile, [key]: value }); }} />)}
      </div>
    </fieldset>)}
  </div>;
}

export function ProfileEditor({ section, profile, update, t, sdk, screen, serial, hardware, placementSerial }: {
  section: ProfileSection; profile: Profile; update: (profile: Profile) => void; t: Translate;
  sdk?: number; screen?: [number, number]; serial?: string; hardware?: string; placementSerial: string;
}) {
  const audioMode = profile.audioMode || (profile.mute ? "phone" : "computer");
  function number(key: "maxSize" | "maxFps" | "bitRate" | "videoBuffer" | "audioBitRate" | "audioBuffer" | "recordSeconds" | "cameraFps", max: number, disabled = false) {
    return <label className="field"><span>{t(key)}</span><input type="number" min={0} max={max} disabled={disabled}
      value={profile[key]} onChange={(e) => update({ ...profile, [key]: Number(e.target.value) })} /></label>;
  }
  function toggle(key: "record" | "readOnly" | "top" | "fullscreen" | "screenOff" | "awake" | "forward" | "cameraHighSpeed" | "cameraTorch" | "noClipboardSync" | "legacyPaste") {
    return <label className="check"><input type="checkbox" checked={profile[key]}
      onChange={(e) => update({ ...profile, [key]: e.target.checked,
        ...(key === "record" && !e.target.checked && audioMode === "recordOnly" ? { audioMode: "phone" } : {}) })} />{t(key)}</label>;
  }
  function choice(key: "codec" | "audioCodec" | "captureOrientation" | "audioSource" | "camera" | "keyboard" | "mouse" | "gamepad",
    options: [string, Message][], disabled = false) {
    return <label className="field"><span>{t(key)}</span><select value={profile[key]} disabled={disabled}
      onChange={(e) => update({ ...profile, [key]: e.target.value })}>
      <option value="">{t("defaultOption")}</option>
      {options.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
    </select></label>;
  }
  function textField(key: "videoEncoder" | "audioEncoder" | "pushTarget", placeholder?: string) {
    return <label className="field"><span>{t(key)}</span><input value={profile[key]} placeholder={placeholder}
      onChange={(event) => update({ ...profile, [key]: event.target.value })} /></label>;
  }
  const crop = profile.crop.split(":");
  const cropValid = !profile.crop || (crop.length === 4 && crop.every((value) => /^\d+$/.test(value))
    && Number(crop[0]) > 0 && Number(crop[1]) > 0
    && (!screen || (Number(crop[0]) + Number(crop[2]) <= screen[0] && Number(crop[1]) + Number(crop[3]) <= screen[1])));
  const inputModes: [string, Message][] = [["sdk", "softwareInput"], ["uhid", "physicalInput"], ["disabled", "disabledOption"]];
  if (section === "quality") return <section className="device-settings-section">
      <h2>{t("quality")}</h2>
      <div className="field-grid" data-tip={t("defaultHint")}>
        {number("maxSize", 8192)}{number("maxFps", 240)}{number("bitRate", 200)}
        {choice("captureOrientation", [["@", "lockInitialOrientation"], ["@0", "portrait"], ["@90", "landscape"], ["@180", "portraitFlipped"], ["@270", "landscapeFlipped"]])}
        <label className="field" data-tip={t("videoBufferHint")}><span>{t("videoBufferPreset")}</span>
          <select value={profile.videoBuffer === 0 ? "0" : profile.videoBuffer === 80 ? "80" : "custom"}
            onChange={(event) => update({ ...profile, videoBuffer: event.target.value === "custom" ? 40 : Number(event.target.value) })}>
            <option value="0">{t("lowestLatency")}</option><option value="80">{t("wirelessSmooth")}</option>
            <option value="custom">{t("customResolution")}</option>
          </select>
        </label>
        {profile.videoBuffer !== 0 && profile.videoBuffer !== 80 && number("videoBuffer", 5000)}
        <label className="field" data-tip={t("cropHint")}><span>{t("crop")}</span>
          <input value={profile.crop} placeholder={screen ? `${screen[0]}:${screen[1]}:0:0` : "1080:1920:0:0"} aria-invalid={!cropValid}
            onChange={(event) => update({ ...profile, crop: event.target.value })} />
        </label>
      </div>
      <CropPreview serial={serial} hardware={hardware} screen={screen} crop={profile.crop} t={t}
        update={(crop) => update({ ...profile, crop })} />
    </section>;
  if (section === "audioOutput") return <section className="device-settings-section">
      <h2>{t("audioOutput")}</h2>
      <div className="field-grid">
        <label className="field" data-tip={t("audioOutputHint")}>
          <span>{t("audioOutput")}</span>
          <select value={audioMode} onChange={(event) => update({ ...profile, audioMode: event.target.value })}>
            <option value="computer">{t("audioOnComputer")}</option>
            <option value="phone">{t("audioOnPhone")}</option>
            <option value="both" disabled={sdk !== undefined && sdk < 33}>{t("audioOnBoth")}</option>
            <option value="recordOnly" disabled={!profile.record}>{t("audioRecordOnly")}</option>
          </select>
        </label>
        {choice("audioSource", [["output", "systemSound"], ["playback", "appSound"], ["mic", "microphone"]], audioMode === "phone" || audioMode === "both")}
        {choice("audioCodec", [["opus", "codecOpus"], ["aac", "codecAac"], ["flac", "codecFlac"], ["raw", "codecRaw"]], audioMode === "phone")}
        {number("audioBitRate", 512, audioMode === "phone" || profile.audioCodec === "raw")}
        {number("audioBuffer", 5000, audioMode === "phone")}
        {textField("audioEncoder")}
      </div>
    </section>;
  if (section === "recordingSettings") return <section className="device-settings-section">
      <h2>{t("recordingSettings")}</h2>
      <div className="settings-stack">
        {toggle("record")}
        <div className="field-grid">
          <label className="field"><span>{t("recordFormat")}</span><select value={profile.recordFormat} disabled={!profile.record}
            onChange={(event) => update({ ...profile, recordFormat: event.target.value })}>
            <option value="mkv">MKV</option><option value="mp4">MP4</option>
          </select></label>
          {number("recordSeconds", 3600, !profile.record)}
        </div>
        <FolderField t={t} value={profile.recordFolder} disabled={!profile.record}
          update={(recordFolder) => update({ ...profile, recordFolder })} />
      </div>
    </section>;
  if (section === "windowBehavior") return <section className="device-settings-section">
      <h2>{t("windowBehavior")}</h2>
      <div className="settings-check-grid">
        {toggle("top")}{toggle("fullscreen")}{toggle("screenOff")}{toggle("awake")}{toggle("readOnly")}
      </div>
      <StartupGeometry serial={placementSerial} hardware={hardware} profile={profile} update={update} t={t} />
    </section>;
  if (section === "advanced") return <section className="device-settings-section">
      <h2>{t("advanced")}</h2>
      <div className="field-grid">
        {choice("codec", [["h264", "codecH264"], ["h265", "codecH265"], ["av1", "codecAv1"]])}
        {textField("videoEncoder")}
        <label className="field"><span>{t("display")}</span><input placeholder="1920x1080" value={profile.display}
          onChange={(e) => update({ ...profile, display: e.target.value })} /></label>
        {choice("keyboard", inputModes)}{choice("mouse", inputModes)}{choice("gamepad", inputModes.slice(1))}
      </div>
      <div className="checks">{toggle("forward")}</div>
    </section>;
  return <section className="device-settings-section">
      <h2>{t("clipboardFiles")}</h2>
      {textField("pushTarget", "/sdcard/Download/")}
      <div className="checks">{toggle("noClipboardSync")}{toggle("legacyPaste")}</div>
    </section>;
}

function CropPreview({ serial, hardware, screen, crop, update, t }: {
  serial?: string; hardware?: string; screen?: [number, number]; crop: string; update: (crop: string) => void; t: Translate;
}) {
  const [image, setImage] = useState<string>();
  const [size, setSize] = useState<[number, number]>();
  const [draft, setDraft] = useState<number[]>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const anchor = useRef<[number, number] | null>(null);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image); }, [image]);
  const natural = size && (!screen || (size[0] >= size[1]) === (screen[0] >= screen[1]));
  const bounds = screen ?? size;
  const selected = draft ?? crop.split(":").map(Number);
  const [width, height, left, top] = selected;
  function point(event: ReactPointerEvent<HTMLDivElement>): [number, number] {
    const rect = event.currentTarget.getBoundingClientRect();
    return [
      Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * bounds![0]),
      Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * bounds![1]),
    ];
  }
  function rectangle(start: [number, number], end: [number, number]) {
    return [Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]), Math.min(start[0], end[0]), Math.min(start[1], end[1])];
  }
  async function capture() {
    setBusy(true);
    setFailure(false);
    setSize(undefined);
    try {
      const bytes = await invoke<ArrayBuffer>("capture_crop_preview", { serial, hardware });
      setImage(URL.createObjectURL(new Blob([bytes], { type: "image/png" })));
    } catch { setFailure(true); }
    finally { setBusy(false); }
  }
  return <div className="settings-stack task-options">
    <div className="tool-row">
      <button type="button" disabled={!serial || busy} onClick={() => void capture()}>{t("cropPreview")}</button>
      {image && <button type="button" onClick={() => { setImage(undefined); setDraft(undefined); anchor.current = null; }}>{t("closeConsoleCrop")}</button>}
      {crop && <button type="button" onClick={() => update("")}>{t("wholePicture")}</button>}
    </div>
    {failure && <small role="alert">{t("captureUnavailable")}</small>}
    {image && <>
      {size && !natural && <small role="status">{t("cropRotatePhone")}</small>}
      <div className="crop-preview" onPointerDown={(event) => {
        if (!natural || !bounds || event.button !== 0) return;
        anchor.current = point(event);
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={(event) => { if (anchor.current) setDraft(rectangle(anchor.current, point(event))); }}
        onPointerCancel={() => { anchor.current = null; setDraft(undefined); }}
        onPointerUp={(event) => {
          if (!anchor.current) return;
          const next = rectangle(anchor.current, point(event));
          anchor.current = null;
          setDraft(undefined);
          if (next[0] > 0 && next[1] > 0) update(next.join(":"));
        }}>
        <img src={image} alt={t("cropPreview")} draggable={false}
          onLoad={(event) => setSize([event.currentTarget.naturalWidth, event.currentTarget.naturalHeight])} />
        {natural && bounds && selected.length === 4 && width > 0 && height > 0 && <div className="crop-selection"
          style={{ width: `${100 * width / bounds[0]}%`, height: `${100 * height / bounds[1]}%`,
            left: `${100 * left / bounds[0]}%`, top: `${100 * top / bounds[1]}%` }} />}
      </div>
    </>}
  </div>;
}

function FolderField({ t, value, update, disabled }: { t: Translate; value: string; update: (value: string) => void; disabled?: boolean }) {
  const [failure, setFailure] = useState(false);
  return <div className="settings-stack">
    <div className="tool-row">
      <label className="field"><span>{t("recordFolder")}</span>
        <input value={value} placeholder={t("defaultOption")} disabled={disabled}
          onChange={(event) => update(event.target.value)} />
      </label>
      <button type="button" disabled={disabled} onClick={async () => {
        try {
          setFailure(false);
          const [folder] = await invoke<string[]>("choose_local_paths", { folder: true });
          if (folder) update(folder);
        } catch { setFailure(true); }
      }}>{t("chooseFolder")}</button>
    </div>
    {failure && <small role="alert">{t("invalidLocalPath")}</small>}
  </div>;
}

const queries = ["displays", "encoders", "apps", "cameras", "cameraSizes", "diagnostics"] as const;
export const toolSections = [
  { id: "query", label: "queryTitle", Icon: ScanSearch },
  { id: "recording", label: "recordingSettings", Icon: Video },
  { id: "audio", label: "audioOnly", Icon: AudioLines },
  { id: "camera", label: "cameraMirror", Icon: Camera },
  { id: "files", label: "fileTools", Icon: FolderUp },
  { id: "control", label: "controlTools", Icon: SlidersHorizontal },
] as const satisfies ReadonlyArray<{ id: string; label: Message; Icon: typeof Camera }>;
export type ToolSection = (typeof toolSections)[number]["id"];

type PhoneApp = { name: string; package: string };
type AppDisplay = { mode: "fixed"; width: number; height: number; wechatInsets?: boolean } | { mode: "follow" };
export type Shortcut = { app: PhoneApp; display: AppDisplay };
export function bindDeviceApps(serial: string, hardware: string, identities: Record<string, string>) {
  const key = `hardware:${hardware}`;
  let changed = false;
  function migrate<T>(storage: string, merge: (legacy: T[]) => T) {
    const saved = loadMap<T>(storage);
    const data = preserveUnboundRecord(serial, hardware, identities, saved);
    const legacy = legacyDeviceKeys(serial, hardware, identities, Object.keys(data))
      .filter((candidate) => Object.prototype.hasOwnProperty.call(data, candidate));
    if (!legacy.length && data === saved) return;
    if (legacy.length) {
      const entries = legacy.map((candidate) => data[candidate]);
      if (data[key] !== undefined) entries.unshift(data[key]);
      data[key] = merge(entries);
      for (const candidate of legacy) delete data[candidate];
    }
    try { saveLocalStorage(storage, JSON.stringify(data)); }
    catch (error) {
      if (storage !== "phone-shortcut-icons") throw error;
      localStorage.removeItem(storage);
    }
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

export function AppWindowPanel({ serial, hardware, deviceKey, title, screen, t }: {
  serial?: string; hardware?: string; deviceKey?: string; title?: string; screen?: [number, number]; t: Translate;
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
    if (!serial || !hardware || !deviceKey) return;
    for (const { app } of shortcuts) {
      if (icons[app.package] || iconRequests.current.has(app.package)) continue;
      iconRequests.current.add(app.package);
      void invoke<string>("app_icon", { serial, hardware, package: app.package }).then((icon) => {
        const cache = loadMap<Record<string, string>>("phone-shortcut-icons");
        cache[deviceKey] = { ...cache[deviceKey], [app.package]: icon };
        setIcons(cache[deviceKey]);
        try { localStorage.setItem("phone-shortcut-icons", JSON.stringify(cache)); } catch { /* 本次仍可显示图标。 */ }
      }).catch(() => {}).finally(() => { iconRequests.current.delete(app.package); });
    }
  }, [serial, hardware, deviceKey, shortcuts, icons, apps]);

  useEffect(() => {
    if (!menu) return;
    function dismiss(event: PointerEvent) {
      if (!(event.target as Element).closest(".shortcut-menu")) setMenu(undefined);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menu]);

  async function loadApps() {
    if (!serial || !hardware || !deviceKey || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const entries = await invoke<PhoneApp[]>("list_apps", { serial, hardware });
      const cache = loadMap<PhoneApp[]>("phone-app-cache");
      cache[deviceKey] = entries;
      saveLocalStorage("phone-app-cache", JSON.stringify(cache));
      setApps(entries);
      if (!entries.some((app) => app.package === selected)) setSelected("");
    } catch (error) {
      setMessage({ key: typeof error === "string" && t(error as Message) ? error as Message : "queryFailed", error: true });
    } finally {
      setBusy(false);
    }
  }

  async function openApp(app: PhoneApp, options: AppDisplay) {
    if (!serial || !hardware || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      await invoke("open_app_window", {
        serial, hardware, package: app.package, title: `${app.name || app.package} · ${title ?? serial}`,
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
    if (!serial || !hardware || !deviceKey) return;
    const saved = loadMap<Shortcut[]>("phone-app-shortcuts");
    saved[deviceKey] = next;
    try { saveLocalStorage("phone-app-shortcuts", JSON.stringify(saved)); }
    catch (error) { setMessage({ key: error as Message, error: true }); return; }
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
            : <LayoutGrid aria-hidden="true" />}
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
        }}><Plus aria-hidden="true" /></button>
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

type FileResult = { path: string; success: boolean; detail: string };
function FileTools({ device, initialTarget, t, active }: {
  device?: Device; initialTarget: string; t: Translate; active: boolean;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [target, setTarget] = useState(initialTarget || "/sdcard/Download/");
  const [results, setResults] = useState<FileResult[]>([]);
  const [install, setInstall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active || busy || device?.status !== "online") return;
    const drop = getCurrentWindow().onDragDropEvent(({ payload }) => {
      if (payload.type !== "drop" || !panel.current) return;
      const rect = panel.current.getBoundingClientRect();
      const x = payload.position.x / window.devicePixelRatio;
      const y = payload.position.y / window.devicePixelRatio;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
      setFiles(payload.paths);
      setResults([]);
      setInstall(false);
      setFailure(undefined);
    });
    return () => { void drop.then((unlisten) => unlisten()).catch(() => {}); };
  }, [active, busy, device?.status]);

  async function choose() {
    setFailure(undefined);
    try {
      const picked = await invoke<string[]>("choose_local_paths", { folder: false });
      if (picked.length) {
        setFiles(picked);
        setResults([]);
        setInstall(false);
      }
    } catch (error) { setFailure(error); }
  }

  async function transfer(paths: string[]) {
    if (!device?.hardware || device.status !== "online" || busy || !paths.length) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const received = await invoke<FileResult[]>("transfer_files", {
        serial: device.serial, hardware: device.hardware, files: paths, target, install,
      });
      setResults((previous) => [...previous.filter((item) => !paths.includes(item.path)), ...received]);
    } catch (error) { setFailure(error); }
    finally { setBusy(false); }
  }

  const failed = results.filter((item) => !item.success).map((item) => item.path);
  const ready = !busy && device?.status === "online" && (install || target.trim().startsWith("/"));
  const allPackages = files.length > 0 && files.every((path) => /\.apk$/i.test(path));
  return <section ref={panel} hidden={!active} className="panel controls settings-card">
    <h2>{t("fileTools")}</h2>
    <div className="tool-row">
      <label className="field"><span>{t("pushTarget")}</span>
        <input value={target} disabled={busy || install} onChange={(event) => setTarget(event.target.value)} />
      </label>
      <button type="button" disabled={busy || device?.status !== "online"} onClick={() => void choose()}>{t("chooseFiles")}</button>
    </div>
    {files.length > 0 && <>
      <ul className="transfer-list">{files.map((path) => {
        const item = results.find((result) => result.path === path);
        return <li key={path} data-tip={item?.detail || path}><span>{path.split(/[\\/]/).pop()}</span>
          {item && <small className={item.success ? "status online" : "status failure"}>{t(item.success ? "fileSucceeded" : "fileFailed")}</small>}
        </li>;
      })}</ul>
      <div className="tool-row">
        {allPackages && <label className="check">
          <input type="checkbox" checked={install} disabled={busy} onChange={(event) => { setInstall(event.target.checked); setResults([]); }} />
          {t("installPackages")}
        </label>}
        <button type="button" disabled={!ready} onClick={() => void transfer(files)}>{t(install ? "installPackages" : "sendFiles")}</button>
        {!!failed.length && <button type="button" disabled={!ready} onClick={() => void transfer(failed)}>{t("retryFailedFiles")}</button>}
      </div>
    </>}
    {busy && <p role="status">{t("working")}</p>}
    <ErrorToast message={failure === undefined ? undefined : errorKey(failure, t)} dismiss={t("dismissNotice")} />
  </section>;
}

export function ToolPanel({ device, profile, section, t, refresh }: {
  device?: Device; profile: Profile; section: ToolSection;
  t: Translate; refresh: () => Promise<void> | null;
}) {
  const [query, setQuery] = useState<typeof queries[number]>("displays");
  const [recordingTask, setRecordingTask] = useState<"backgroundRecord" | "audioRecord">("backgroundRecord");
  const [controlTask, setControlTask] = useState<"controlOnly" | "directControl">("controlOnly");
  const [durations, setDurations] = useState<Partial<Record<NonNullable<Device["task"]>, number>>>({});
  const [directSerial, setDirectSerial] = useState("");
  const [folder, setFolder] = useState(profile.recordFolder);
  const [recordFormat, setRecordFormat] = useState(profile.recordFormat);
  const [audioFormat, setAudioFormat] = useState("opus");
  const [audioSource, setAudioSource] = useState("output");
  const [camera, setCamera] = useState({ ...profile, camera: profile.camera || "back", audioMode: profile.audioMode === "computer" || (!profile.audioMode && !profile.mute) ? "computer" : "phone" });
  const task = section === "recording" ? recordingTask : section === "camera" ? "cameraMirror" : section === "audio" ? "audioOnly" : controlTask;
  const records = section === "recording";
  const format = recordingTask === "audioRecord" ? audioFormat : recordFormat;
  const timed = task !== "directControl" && task !== "cameraMirror";
  const seconds = task === "cameraMirror" ? 15 : durations[task] ?? 15;
  const [busy, setBusy] = useState(false);
  type ToolResult = { serial: string; text?: string; message?: Message; error?: unknown };
  const [results, setResults] = useState<Partial<Record<ToolSection, ToolResult>>>({});
  const result = results[section];

  function setResult(value?: ToolResult) {
    setResults((previous) => ({ ...previous, [section]: value }));
  }

  async function run(kind: "query" | "task", queryOverride = query) {
    const serial = kind === "task" && task === "directControl"
      ? directSerial.trim() || (device?.connection === "wired" ? device.serial : "")
      : device?.serial;
    const hardware = serial === device?.serial ? device?.hardware : undefined;
    if (!serial || busy || (!hardware && (kind === "query" || task !== "directControl"))) return;
    setBusy(true);
    setResult(undefined);
    try {
      if (kind === "query") {
        const output = await invoke<{ text: string; success: boolean }>("query_device", { serial, hardware, query: queryOverride });
        setResult({ serial, text: output.text, error: output.success ? undefined : "queryFailed" });
      } else {
        const text = await invoke<string | null>("run_tool", { serial, hardware, task, seconds,
          folder: records ? folder : null, format: records ? format : null,
          audioSource: task === "audioRecord" ? audioSource : null, profile: task === "cameraMirror" ? camera : null,
        });
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
  const activeSection = toolSections.find((item) => item.id === section)!;
  return <div className="settings-stack">
    {section === "query" && <section className="panel controls settings-card">
      <h2>{t("queryTitle")}</h2>
      <div className="tool-row settings-tool-row">
        <label className="field"><span>{t("queryType")}</span><select value={query}
          onChange={(e) => setQuery(e.target.value as typeof query)}>
          {queries.map((entry) => <option key={entry} value={entry}>{t(entry)}</option>)}
        </select></label>
        <button type="button" disabled={busy || device?.status !== "online"} onClick={() => void run("query")}>{t("queryRun")}</button>
      </div>
    </section>}
    {section !== "query" && section !== "files" && <section className="panel controls settings-card">
      <h2>{t(activeSection.label)}</h2>
      {section !== "camera" && <div className="tool-row settings-tool-row">
        {section === "recording" && <label className="field"><span>{t("taskType")}</span>
          <select value={recordingTask} disabled={busy} onChange={(event) => setRecordingTask(event.target.value as typeof recordingTask)}>
            <option value="backgroundRecord">{t("backgroundRecord")}</option>
            <option value="audioRecord">{t("audioRecord")}</option>
          </select>
        </label>}
        {section === "control" && <label className="field"><span>{t("taskType")}</span>
          <select value={controlTask} disabled={busy} onChange={(event) => setControlTask(event.target.value as typeof controlTask)}>
            <option value="controlOnly">{t("controlOnly")}</option>
            <option value="directControl">{t("directControl")}</option>
          </select>
        </label>}
        {task !== "cameraMirror" && timed && <label className="field duration"><span>{t("duration")}</span>
          <input type="number" value={seconds} min={3} max={300} disabled={busy}
            onChange={(event) => {
              const value = Number(event.target.value);
              setDurations((previous) => ({ ...previous, [task]: value }));
            }} /></label>}
        {task === "directControl" && <label className="field"><span>{t("wiredSerial")}</span>
          <input value={directSerial} placeholder={device?.connection === "wired" ? device.serial : undefined}
            maxLength={128} onChange={(e) => setDirectSerial(e.target.value)} /></label>}
      </div>}
      {records && <div className="settings-stack task-options">
        <div className="field-grid">
          <label className="field"><span>{t("recordFormat")}</span><select value={format}
            onChange={(event) => (task === "audioRecord" ? setAudioFormat : setRecordFormat)(event.target.value)}>
            {(task === "audioRecord" ? ["opus", "flac", "wav"] : ["mkv", "mp4"])
              .map((entry) => <option key={entry} value={entry}>{entry.toUpperCase()}</option>)}
          </select></label>
          {task === "audioRecord" && <label className="field"><span>{t("audioSource")}</span>
            <select value={audioSource} onChange={(event) => setAudioSource(event.target.value)}>
              <option value="output">{t("systemSound")}</option><option value="mic">{t("microphone")}</option>
            </select>
          </label>}
        </div>
        <FolderField t={t} value={folder} update={setFolder} disabled={busy} />
      </div>}
      {task === "cameraMirror" && <div className="settings-stack task-options">
        <div className="tool-row">
          <button type="button" disabled={busy || device?.status !== "online"} onClick={() => void run("query", "cameras")}>{t("cameras")}</button>
          <button type="button" disabled={busy || device?.status !== "online"} onClick={() => void run("query", "cameraSizes")}>{t("cameraSizes")}</button>
        </div>
        <div className="field-grid">
          <label className="field"><span>{t("camera")}</span><select value={camera.camera}
            onChange={(event) => setCamera({ ...camera, camera: event.target.value })}>
            <option value="back">{t("backCamera")}</option><option value="front">{t("frontCamera")}</option>
            <option value="external">{t("externalCamera")}</option>
          </select></label>
          {(["cameraId", "cameraSize", "cameraZoom"] as const).map((key) =>
            <label key={key} className="field"><span>{t(key)}</span><input value={camera[key]} placeholder={t("defaultOption")}
              onChange={(event) => setCamera({ ...camera, [key]: event.target.value })} /></label>)}
          <label className="field"><span>{t("cameraFps")}</span><input type="number" min={0} max={240} value={camera.cameraFps}
            onChange={(event) => setCamera({ ...camera, cameraFps: Number(event.target.value) })} /></label>
          <label className="field"><span>{t("audioMode")}</span>
            <select value={camera.audioMode || (camera.mute ? "phone" : "computer")}
              onChange={(event) => setCamera({ ...camera, audioMode: event.target.value })}>
              <option value="phone">{t("audioOnPhone")}</option><option value="computer">{t("audioOnComputer")}</option>
            </select>
          </label>
          <label className="field"><span>{t("audioSource")}</span>
            <select value={camera.audioSource} disabled={(camera.audioMode || (camera.mute ? "phone" : "computer")) === "phone"}
              onChange={(event) => setCamera({ ...camera, audioSource: event.target.value })}>
              <option value="">{t("defaultOption")}</option><option value="mic">{t("microphone")}</option>
              <option value="output">{t("systemSound")}</option>
            </select>
          </label>
        </div>
        <div className="checks">
          {(["cameraHighSpeed", "cameraTorch"] as const).map((key) => <label key={key} className="check">
            <input type="checkbox" checked={camera[key]} onChange={(event) => setCamera({ ...camera, [key]: event.target.checked })} />{t(key)}
          </label>)}
        </div>
      </div>}
      {sessionActive && <p>{t("taskBusy")}</p>}
      <div className="form-actions">
        <button type="button" className="primary-action"
          data-tip={t(records ? "backgroundHint" : task === "cameraMirror" ? "cameraTaskHint" : task === "directControl" ? "directHint" : "taskHint")}
          disabled={busy || (task === "directControl"
          ? !wiredSerial || (sessionActive && wiredSerial === device?.serial)
          : sessionActive || device?.status !== "online" || (timed && (!Number.isInteger(seconds) || seconds < 3 || seconds > 300)))}
          onClick={() => void run("task")}>{t("taskRun")}</button>
      </div>
    </section>}
    {busy && section !== "files" && <p role="status">{t("working")}</p>}
    <ErrorToast message={activeResult?.error === undefined ? undefined : errorKey(activeResult.error, t)} dismiss={t("dismissNotice")} />
    {activeResult && (activeResult.message || activeResult.text !== undefined) && <div className="panel controls settings-card settings-wide" aria-live="polite">
      {activeResult.message && <p>{t(activeResult.message)}</p>}
      {activeResult.text !== undefined && <pre>{activeResult.text || t("noResult")}</pre>}
      {activeResult.message && activeResult.text && !sessionActive && <button type="button" onClick={async () => {
        try { await invoke("reveal_capture", { path: activeResult.text }); }
        catch (error) { setResult({ ...activeResult, error }); }
      }}>{t("revealRecording")}</button>}
    </div>}
    <FileTools device={device} initialTarget={profile.pushTarget} t={t} active={section === "files"} />
  </div>;
}
