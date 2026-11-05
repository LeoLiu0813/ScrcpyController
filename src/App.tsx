import { AudioLines, ClipboardList, Film, MonitorCog, Terminal, UserRound } from "lucide-react";
import ControlAppearance from "./ControlAppearance";
import { Monitor, Settings, RefreshCw, Smartphone, Trash2, ListChecks, WifiOff, Wifi,
  Play, Scan, Square, LockKeyhole, SlidersHorizontal, Pencil, RotateCcw, Minus, Maximize2, X,
  AppWindow, GripVertical, Languages, Palette, PackageCheck, ScrollText } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getInitialLocale, locales, type Locale, type Message } from "./locales";
import { currentDeviceKey, deviceStorageKey, bindDeviceRecord, legacyDeviceKeys, verifiedDeviceBinding } from "./deviceAliases";
import { AppWindowPanel, bindDeviceApps, defaultProfile, loadMap, ProfileEditor, ToolPanel, toolSections, type Device, type Profile, type ToolSection } from "./Workflows";
import ConnectionDialog from "./ConnectionDialog";
import { MirrorAppearance } from "./MirrorWindow";
import ErrorToast from "./ErrorToast";
import EngineUpdate from "./EngineUpdate";
import ControlLog from "./ControlLog";
import LaunchArgumentsEditor from "./LaunchArgumentsEditor";
import { saveLocalStorage } from "./localStorage";
import "./App.css";

const icons = {
  devices: Monitor, settings: Settings, refresh: RefreshCw, addDevice: Smartphone,
  trash: Trash2, selectDevices: ListChecks, disconnect: WifiOff, wireless: Wifi,
  open: Play, focus: Scan, stop: Square, lock: LockKeyhole, profiles: SlidersHorizontal,
  rename: Pencil, reset: RotateCcw, minimize: Minus, maximize: Maximize2,
  close: X, appWindows: AppWindow,
};

const deviceSettingsSections = [
  ["editDevice", UserRound], ["quality", Monitor], ["audioOutput", AudioLines],
  ["recordingSettings", Film], ["windowBehavior", MonitorCog], ["advanced", SlidersHorizontal],
  ["clipboardFiles", ClipboardList], ["launchPreview", Terminal],
] as const;
type DeviceSettingsSection = typeof deviceSettingsSections[number][0];

const brands = ["generic", "oneplus", "xiaomi", "google", "samsung"] as const;
type Brand = typeof brands[number];
type Mark = { brand: Brand | "auto"; badge: string };
const defaultMark: Mark = { brand: "auto", badge: "" };
type DeviceFacts = { hardware: string; transportId: Device["transportId"]; brand: Brand; manufacturer: string; size?: [number, number]; sdk?: number };
type DeviceBrand = Pick<DeviceFacts, "brand" | "manufacturer">;
type KnownDevice = Pick<Device, "serial" | "model" | "connection">;
const resizeEdges = ["North", "South", "East", "West", "NorthEast", "NorthWest", "SouthEast", "SouthWest"] as const;

function readSerials(key: string): string[] {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(values) ? [...new Set(values.filter((item): item is string => typeof item === "string"))] : [];
  } catch {
    return [];
  }
}

function sameConnection(first: Pick<Device, "hardware" | "transportId">, second?: Pick<Device, "hardware" | "transportId">) {
  return !!second && first.hardware === second.hardware && first.transportId === second.transportId;
}

function readMarks() {
  if (localStorage.getItem("device-marks-v2")) return loadMap<Mark>("device-marks-v2");
  return Object.fromEntries(Object.entries(loadMap<Mark>("device-marks"))
    .map(([serial, mark]) => [serial, { ...defaultMark, badge: mark.badge }]));
}

function migrateDeviceBindings(devices: Device[]) {
  const identities = loadMap<string>("device-identities");
  const aliases = loadMap<string>("device-aliases");
  const profiles = loadMap<Profile>("device-profiles");
  const marks = readMarks();
  let updatedAliases = aliases, updatedProfiles = profiles, updatedMarks = marks, changedIdentity = false;
  for (const { serial, hardware } of devices) {
    if (!hardware) continue;
    changedIdentity ||= identities[serial] !== hardware;
    verifiedDeviceBinding(serial, hardware, identities, (endpoint, id, bindings) => {
      updatedAliases = bindDeviceRecord(endpoint, id, bindings, updatedAliases);
      updatedProfiles = bindDeviceRecord(endpoint, id, bindings, updatedProfiles);
      updatedMarks = bindDeviceRecord(endpoint, id, bindings, updatedMarks);
      bindDeviceApps(endpoint, id, bindings);
    });
  }
  if (updatedAliases !== aliases) saveLocalStorage("device-aliases", JSON.stringify(updatedAliases));
  if (updatedProfiles !== profiles) saveLocalStorage("device-profiles", JSON.stringify(updatedProfiles));
  if (updatedMarks !== marks) saveLocalStorage("device-marks-v2", JSON.stringify(updatedMarks));
  if (changedIdentity) saveLocalStorage("device-identities", JSON.stringify(identities));
  return { identities: changedIdentity ? identities : undefined,
    aliases: updatedAliases !== aliases ? updatedAliases : undefined,
    profiles: updatedProfiles !== profiles ? updatedProfiles : undefined,
    marks: updatedMarks !== marks ? updatedMarks : undefined };
}

function opacity(key: string, fallback: number) {
  const value = Number(localStorage.getItem(key));
  return value >= 20 && value <= 100 ? value : fallback;
}

function DeviceMark({ mark, detected }: { mark: Mark; detected?: Brand }) {
  const brand = mark.brand === "auto" ? detected ?? "generic" : mark.brand;
  return <span className="device-mark" aria-hidden="true">
    {brand === "generic" ? <Smartphone aria-hidden="true" />
      : <span className={`brand-symbol brand-${brand}`} />}
    {mark.badge && <span className="device-badge">{mark.badge}</span>}
  </span>;
}

function IconButton({ icon, label, text, active, disabled, onClick }: {
  icon: keyof typeof icons;
  label: string;
  text?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const Glyph = icons[icon];
  return (
    <button type="button" className="icon-button" aria-label={label}
      aria-pressed={active} data-tip={label} disabled={disabled} onClick={onClick}>
      <Glyph aria-hidden="true" />
      {text && <span>{text}</span>}
    </button>
  );
}

function errorKey(error: unknown): Message {
  return typeof error === "string" && Object.prototype.hasOwnProperty.call(locales["zh-CN"], error)
    ? error as Message
    : "sessionError";
}

export default function App() {
  const [locale, setLocale] = useState(getInitialLocale);
  const [closeBehavior, setCloseBehavior] = useState<"tray" | "exit">(() =>
    localStorage.getItem("main-close-behavior") === "exit" ? "exit" : "tray");
  const [toolSection, setToolSection] = useState<ToolSection>("query");
  const [settingsSection, setSettingsSection] = useState<"general" | "appearance" | "engine" | "logs">("general");
  const [enginePanel, setEnginePanel] = useState<HTMLDivElement | null>(null);
  const [page, setPage] = useState<"devices" | "tools" | "appWindows" | "settings">("devices");
  const [profileSerial, setProfileSerial] = useState<string>();
  const [deviceSettingsSection, setDeviceSettingsSection] = useState<DeviceSettingsSection>("editDevice");
  const deviceSettingsBody = useRef<HTMLDivElement>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const liveDevices = useRef(new Map<string, Device>());
  const [known, setKnown] = useState(() => loadMap<KnownDevice>("known-devices"));
  const [order, setOrder] = useState(() => readSerials("device-order"));
  const [removed, setRemoved] = useState(() => {
    const ids = loadMap<string>("device-identities");
    return [...new Set(readSerials("removed-devices").map((key) => deviceStorageKey(key, ids)))];
  });
  const removedRef = useRef(new Set(removed));
  const [bulk, setBulk] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [deleteRequest, setDeleteRequest] = useState<{ serial: string; key: string }[]>();
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<Message>();
  const [actionError, setActionError] = useState<Message>();
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [aliases, setAliases] = useState(() => loadMap<string>("device-aliases"));
  const [identities, setIdentities] = useState(() => loadMap<string>("device-identities"));
  const [profiles, setProfiles] = useState(() => loadMap<Profile>("device-profiles"));
  const [selected, setSelected] = useState(() => localStorage.getItem("selected-device") ?? "");
  const selection = useRef(selected);
  const selectedHardware = useRef<string | undefined>(identities[selected]);
  const requireSelection = useRef(false);
  const [marks, setMarks] = useState(readMarks);
  const [facts, setFacts] = useState<Record<string, DeviceFacts>>({});
  const [deviceBrands, setDeviceBrands] = useState(() => loadMap<DeviceBrand>("device-brands"));
  const factRequests = useRef(new Set<string>());
  const [phoneMenu, setPhoneMenu] = useState(false);
  const [editing, setEditing] = useState<{ serial: string; key: string; value: string; originalName: string } & Mark>();
  const [dragging, setDragging] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const [windowOpacity, setWindowOpacity] = useState(() => opacity("window-opacity", 88));
  const [panelOpacity, setPanelOpacity] = useState(() => opacity("panel-opacity", 86));
  const [capture, setCapture] = useState<{ name: string; path: string; serial: string }>();
  const [preview, setPreview] = useState<{ serial: string; profile: Profile; title: string; args: string[] }>();
  const refreshing = useRef<Promise<void> | null>(null);
  const messages = locales[locale];
  const t = (key: Message) => messages[key];
  const merged = new Map<string, Device>(Object.values(known).map((device) => [
    device.serial, { ...device, status: "offline", session: "idle" },
  ]));
  const live = new Map(devices.map((device) => [device.serial, device]));
  for (const device of devices) merged.set(device.serial, device);
  for (const [serial, device] of merged) if (isRemoved(device)) merged.delete(serial);
  const hiddenDevices = devices.filter((device) => device.hardware && isRemoved(device));
  const connectionOrder = [...new Set([...order, ...merged.keys()])]
    .flatMap((serial) => { const device = merged.get(serial); return device ? [device] : []; });
  const displayedDevices = new Map<string, Device>();
  for (const device of connectionOrder) {
    const key = displayKey(device);
    const previous = displayedDevices.get(key);
    if (!previous || displayPriority(device) > displayPriority(previous)) displayedDevices.set(key, device);
  }
  const ordered = [...displayedDevices.values()];
  const requestedTarget = selected ? merged.get(selected) : undefined;
  const selectedKey = requestedTarget ? displayKey(requestedTarget)
    : selectedHardware.current ? `hardware:${selectedHardware.current}` : undefined;
  const target = selectedKey ? displayedDevices.get(selectedKey) : undefined;
  const nativeWindow = getCurrentWindow();
  const windowStyle = { "--window-opacity": `${windowOpacity}%`, "--panel-opacity": `${panelOpacity}%` } as CSSProperties;
  const configuring = profileSerial ? merged.get(profileSerial) : undefined;
  const configured = configuring && editing && keyFor(configuring.serial) === editing.key ? configuring : undefined;
  const currentProfile = configured ? profileFor(configured.serial) : defaultProfile;
  const appDeviceKey = target && keyFor(target.serial);
  const currentTitle = target ? deviceName(target) : "";

  function keyFor(serial: string) {
    return currentDeviceKey(serial, live.get(serial), identities);
  }

  function displayKey(device: Device) {
    const hardware = device.hardware ?? (device.status !== "online" ? identities[device.serial] : undefined);
    return hardware ? `hardware:${hardware}` : device.serial;
  }

  function displayPriority(device: Device) {
    const active = ["starting", "running", "stopping"].includes(device.session);
    return Number(active) * 4 + Number(device.status === "online") * 2 + Number(device.serial === selected);
  }

  function persistSetting(key: string, value: string) {
    try { saveLocalStorage(key, value); return true; }
    catch (error) { setActionError(errorKey(error)); return false; }
  }

  function isRemoved(device: Device) {
    const key = keyFor(device.serial);
    return (key && removed.includes(key)) || removed.includes(device.serial);
  }

  function usable(device?: Device) {
    return !listError && device?.status === "online" && !!device.hardware;
  }

  function statusLabel(device: Device) {
    return t(device.status === "online" && !device.hardware ? "deviceVerifying" : device.status);
  }

  function deviceValue<T>(serial: string, values: Record<string, T>): T | undefined {
    const key = keyFor(serial);
    if (!key) return undefined;
    if (live.has(serial) || values[key] !== undefined) return values[key];
    const hardware = identities[serial];
    const legacy = hardware && legacyDeviceKeys(serial, hardware, identities, Object.keys(values))
      .find((candidate) => values[candidate] !== undefined);
    return legacy ? values[legacy] : undefined;
  }

  function profileFor(serial: string): Profile {
    const saved = deviceValue(serial, profiles);
    return saved ? { ...defaultProfile, ...saved } : defaultProfile;
  }

  function normalProfile(serial: string): Profile {
    return { ...profileFor(serial), camera: "", cameraId: "" };
  }

  function deviceAlias(serial: string) {
    return deviceValue(serial, aliases);
  }

  function deviceName(device: Device) {
    return deviceAlias(device.serial) || device.model;
  }

  function canDelete(device: Device) {
    const key = keyFor(device.serial);
    return !!key && [...merged.values()].every((entry) => keyFor(entry.serial) !== key ||
      (!pending.has(entry.serial) && ["idle", "failed"].includes(entry.session)));
  }

  function setRemovedDevices(next: string[]) {
    if (!persistSetting("removed-devices", JSON.stringify(next))) return false;
    removedRef.current = new Set(next);
    setRemoved(next);
    return true;
  }

  async function restoreDevice(serial: string, expectedHardware?: string) {
    if (refreshing.current) await refreshing.current;
    await refresh();
    const hardware = liveDevices.current.get(serial)?.hardware;
    if (!hardware || (expectedHardware && hardware !== expectedHardware)) return false;
    const key = `hardware:${hardware}`;
    if (removedRef.current.has(serial) || removedRef.current.has(key)) {
      if (!setRemovedDevices([...removedRef.current].filter((entry) => entry !== serial && entry !== key))) return false;
    }
    return true;
  }

  function deleteDevices() {
    const items = (deleteRequest ?? []).filter(({ serial, key }) => {
      const device = merged.get(serial);
      return device && keyFor(serial) === key && canDelete(device);
    });
    setDeleteRequest(undefined);
    if (items.length !== deleteRequest?.length) {
      setActionError("closeBeforeDelete");
      return;
    }
    if (!items.length) return;
    const keys = new Set(items.map(({ key }) => key));
    const ids = [...merged.keys()].filter((serial) => {
      const key = keyFor(serial);
      return key && keys.has(key);
    });
    const deleted = new Set(ids);
    if (!setRemovedDevices([...new Set([...removedRef.current, ...keys])])) return;
    function withoutDeleted<T>(key: string, source = loadMap<T>(key), includeHardware = false) {
      const next = { ...source };
      for (const id of ids) delete next[id];
      if (includeHardware) for (const id of keys) delete next[id];
      persistSetting(key, JSON.stringify(next));
      return next;
    }
    setKnown(withoutDeleted("known-devices", known));
    setAliases(withoutDeleted<string>("device-aliases"));
    setMarks(withoutDeleted("device-marks-v2", marks, true));
    setProfiles(withoutDeleted("device-profiles", profiles, true));
    setDeviceBrands(withoutDeleted("device-brands", deviceBrands, true));
    for (const key of ["device-marks", "wireless-endpoints"]) withoutDeleted(key);
    setOrder((previous) => previous.filter((serial) => !deleted.has(serial)));
    setChecked((previous) => new Set([...previous].filter((serial) => !deleted.has(serial))));
    setBulk(false);
    if (deleted.has(selected)) {
      const remaining = ordered.filter((device) => !deleted.has(device.serial));
      selectDevice((remaining.find((device) => device.status === "online") ?? remaining[0])?.serial ?? "");
    }
  }

  function openDeviceSettings(device: Device) {
    const key = keyFor(device.serial);
    if (!key) return;
    setPreview(undefined);
    setActionError(undefined);
    setProfileSerial(device.serial);
    setDeviceSettingsSection("editDevice");
    const value = deviceAlias(device.serial) ?? "";
    setEditing({ serial: device.serial, key, value, originalName: value, ...(deviceValue(device.serial, marks) ?? defaultMark) });
  }

  function brandFor(serial: string) {
    return facts[serial] ?? deviceValue(serial, deviceBrands);
  }

  function manufacturerFor(serial: string) {
    const detected = brandFor(serial);
    return detected?.brand === "generic" ? detected.manufacturer : detected?.brand;
  }

  function visibleMark(serial: string): Mark {
    const mark = deviceValue(serial, marks) ?? defaultMark;
    const manufacturer = manufacturerFor(serial);
    const siblings = new Map(ordered.filter((device) => manufacturer && manufacturerFor(device.serial) === manufacturer)
      .flatMap((device) => {
        const key = keyFor(device.serial);
        return key ? [[key, device.serial] as const] : [];
      }));
    if (siblings.size < 2) return { ...mark, badge: "" };
    const assigned = new Map<string, string>();
    const used = new Set<string>();
    const stable = [...siblings.keys()].sort();
    for (const id of stable) {
      const badge = deviceValue(siblings.get(id)!, marks)?.badge;
      if (badge && !used.has(badge)) { assigned.set(id, badge); used.add(badge); }
    }
    let number = 1;
    for (const id of stable) {
      if (assigned.has(id)) continue;
      while (used.has(String(number))) number++;
      assigned.set(id, String(number++));
    }
    return { ...mark, badge: assigned.get(keyFor(serial) ?? "") ?? "" };
  }

  function selectDevice(serial: string) {
    setPhoneMenu(false);
    selection.current = serial;
    selectedHardware.current = liveDevices.current.get(serial)?.hardware ?? loadMap<string>("device-identities")[serial];
    requireSelection.current = false;
    setSelected(serial);
    setActionError(undefined);
    setCapture(undefined);
  }

  function moveDevice(serial: string, destination: number) {
    const ids = ordered.map((device) => device.serial);
    const from = ids.indexOf(serial);
    if (from < 0 || destination < 0 || destination >= ids.length || from === destination) return;
    ids.splice(from, 1);
    ids.splice(destination, 0, serial);
    setOrder([...ids, ...order.filter((serial) => !ids.includes(serial))]);
  }

  async function previewProfile(extraArgs: string[]) {
    if (!configured) return;
    const title = deviceName(configured);
    const profile = { ...currentProfile, extraArgs };
    setActionError(undefined);
    setPreview(undefined);
    try {
      const args = await invoke<string[]>("preview_profile", {
        serial: configured.serial, title, profile: { ...normalProfile(configured.serial), extraArgs },
      });
      setPreview({ serial: configured.serial, profile, title, args });
    } catch (error) {
      setActionError(errorKey(error));
    }
  }

  function saveProfile(key: string, profile: Profile) {
    const next = { ...loadMap<Profile>("device-profiles"), [key]: profile };
    try {
      saveLocalStorage("device-profiles", JSON.stringify(next));
      setProfiles(next);
    } catch (error) { setActionError(errorKey(error)); }
  }

  function saveDeviceMark(key: string, mark: Mark) {
    const next = { ...readMarks(), [key]: mark };
    try {
      saveLocalStorage("device-marks-v2", JSON.stringify(next));
      setMarks(next);
      return true;
    } catch (error) { setActionError(errorKey(error)); return false; }
  }

  function saveAlias() {
    if (!editing || keyFor(editing.serial) !== editing.key) return;
    const value = editing.value.trim();
    if (Array.from(value).length > 60 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
      setActionError("invalidName");
      return;
    }
    if (value !== editing.originalName) {
      const next = loadMap<string>("device-aliases");
      if (value) next[editing.key] = value;
      else delete next[editing.key];
      try { saveLocalStorage("device-aliases", JSON.stringify(next)); }
      catch (error) { setActionError(errorKey(error)); return; }
      setAliases(next);
    }
    if (!saveDeviceMark(editing.key, { brand: editing.brand, badge: editing.badge })) return;
    setEditing({ ...editing, value, originalName: value });
    setActionError(undefined);
  }

  const refresh = useCallback(() => {
    if (!refreshing.current) {
      refreshing.current = invoke<Device[]>("list_devices")
        .then((next) => {
          const bindings = next.filter((device) => device.hardware && liveDevices.current.get(device.serial)?.hardware !== device.hardware);
          if (bindings.length) {
            const updates = migrateDeviceBindings(bindings);
            if (updates.identities) setIdentities(updates.identities);
            if (updates.aliases) setAliases(updates.aliases);
            if (updates.profiles) setProfiles(updates.profiles);
            if (updates.marks) setMarks(updates.marks);
            const serials = new Set(bindings.map(({ serial }) => serial));
            setChecked((previous) => new Set([...previous].filter((serial) => !serials.has(serial))));
          }
          liveDevices.current = new Map(next.map((device) => [device.serial, device]));
          setDevices(next);
          setFacts((previous) => {
            const facts = Object.entries(previous);
            const current = facts.filter(([serial, fact]) => sameConnection(fact, liveDevices.current.get(serial)));
            return current.length === facts.length ? previous : Object.fromEntries(current);
          });
          setListError(undefined);
          setKnown((previous) => {
            let result = previous;
            for (const { serial, model, connection, hardware } of next) {
              if (!hardware || removedRef.current.has(serial) || removedRef.current.has(`hardware:${hardware}`)) continue;
              if (previous[serial]?.model === model && previous[serial]?.connection === connection) continue;
              if (result === previous) result = Object.assign(Object.create(null), previous);
              result[serial] = { serial, model, connection };
            }
            return result;
          });
          const available = next.filter((device) => !removedRef.current.has(device.serial) &&
            (!device.hardware || !removedRef.current.has(`hardware:${device.hardware}`)));
          const current = available.find((device) => device.serial === selection.current);
          const hardware = selectedHardware.current;
          const replacement = hardware && current?.hardware && hardware !== current.hardware;
          const alternate = hardware && (!current || current.status !== "online" || replacement)
            ? available.find((device) => device.status === "online" && device.hardware === hardware) : undefined;
          if (alternate) selectDevice(alternate.serial);
          else if (replacement) {
            selectDevice("");
            requireSelection.current = true;
            setActionError("deviceIdentityMismatch");
          } else if (!selection.current && !requireSelection.current) {
            const first = available.find((device) => device.status === "online" && device.hardware);
            if (first) selectDevice(first.serial);
          } else if (current?.hardware && !hardware) selectedHardware.current = current.hardware;
        })
        .catch((error: unknown) => setListError(errorKey(error)))
        .finally(() => { refreshing.current = null; setLoading(false); });
    }
    return refreshing.current;
  }, []);

  const traySettings = JSON.stringify({
    english: locale === "en-US",
    exitOnClose: closeBehavior === "exit",
    devices: connectionOrder.filter((device) => usable(device)).map((device) => ({
      serial: device.serial,
      hardware: device.hardware,
      name: deviceName(device),
      alias: deviceAlias(device.serial) ?? null,
      profile: normalProfile(device.serial),
    })),
    removed,
  });
  useEffect(() => {
    void invoke("tray_sync", JSON.parse(traySettings)).catch(() => {});
  }, [traySettings]);
  useEffect(() => {
    const listener = listen<{ serial: string; hardware: string }>("open-file-tools", ({ payload }) => {
      const device = liveDevices.current.get(payload.serial);
      if (!payload.hardware || device?.hardware !== payload.hardware || device.status !== "online" ||
        removedRef.current.has(payload.serial) || removedRef.current.has(`hardware:${payload.hardware}`)) {
        setActionError("deviceIdentityMismatch");
        return;
      }
      selectDevice(payload.serial);
      setToolSection("files");
      setPage("tools");
    });
    return () => { void listener.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

  useEffect(() => {
    const listener = listen("open-control-logs", () => {
      setSettingsSection("logs");
      setPage("settings");
    });
    return () => { void listener.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

  useEffect(() => {
    const listener = listen<string>("tray-device-error", ({ payload }) => setActionError(errorKey(payload)));
    return () => { void listener.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

  useEffect(() => {
    persistSetting("display-language", locale);
    document.documentElement.lang = locale;
    document.title = messages.title;
    void getCurrentWindow().setTitle(messages.title).catch(() => {});
  }, [locale, messages.title]);

  useEffect(() => { persistSetting("known-devices", JSON.stringify(known)); }, [known]);
  useEffect(() => { persistSetting("removed-devices", JSON.stringify(removed)); }, [removed]);
  useEffect(() => { persistSetting("device-order", JSON.stringify(order)); }, [order]);
  useEffect(() => { persistSetting("selected-device", selected); }, [selected]);
  useEffect(() => { persistSetting("main-close-behavior", closeBehavior); }, [closeBehavior]);
  useEffect(() => { persistSetting("window-opacity", String(windowOpacity)); }, [windowOpacity]);
  useEffect(() => { persistSetting("panel-opacity", String(panelOpacity)); }, [panelOpacity]);

  useEffect(() => {
    if (target && target.serial !== selected) selectDevice(target.serial);
  }, [target?.serial, selected]);

  useEffect(() => {
    if (profileSerial && !configured) setProfileSerial(undefined);
  }, [profileSerial, configured]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 1200);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    for (const device of devices) {
      const { serial, status, hardware, transportId } = device;
      const request = JSON.stringify([serial, transportId, hardware]);
      if (status !== "online" || !hardware || sameConnection(device, facts[serial]) || factRequests.current.has(request)) continue;
      factRequests.current.add(request);
      void invoke<{ text: string; success: boolean }>("query_device", { serial, hardware, query: "deviceFacts" })
        .then(({ text, success }) => {
          if (!success || !sameConnection(device, liveDevices.current.get(serial))) return;
          const manufacturer = text.split(/\r?\n/)[0].toLowerCase();
          const brand = brands.find((value) => manufacturer.includes(value)) ??
            (/redmi|poco/.test(manufacturer) ? "xiaomi" : "generic");
          setDeviceBrands((previous) => {
            const key = `hardware:${hardware}`;
            if (previous[key]?.brand === brand && previous[key]?.manufacturer === manufacturer) return previous;
            const next = { ...previous, [key]: { brand, manufacturer } };
            try { saveLocalStorage("device-brands", JSON.stringify(next)); } catch { /* 本次仍使用已识别的图标。 */ }
            return next;
          });
          const match = text.match(/Physical size:\s*(\d+)x(\d+)/);
          setFacts((previous) => ({ ...previous, [serial]: {
            hardware, transportId, brand, manufacturer, sdk: Number(text.match(/^controller-sdk:(\d+)\s*$/m)?.[1]) || undefined,
            size: match ? [Number(match[1]), Number(match[2])] : undefined,
          } }));
        }).catch(() => {}).finally(() => { factRequests.current.delete(request); });
    }
  }, [devices, facts]);

  async function lockDevice(device: Device) {
    const serial = device.serial;
    if (pending.has(serial) || !usable(device)) return;
    setActionError(undefined);
    setPending((previous) => new Set(previous).add(serial));
    try {
      await invoke("lock_device", { serial, hardware: device.hardware });
    } catch (error) {
      setActionError(errorKey(error));
    } finally {
      setPending((previous) => {
        const next = new Set(previous);
        next.delete(serial);
        return next;
      });
    }
  }

  async function operate(device: Device, operation: "open_device" | "stop_device") {
    if (pending.has(device.serial) || (operation === "open_device" && !usable(device))) return;
    setPending((previous) => new Set(previous).add(device.serial));
    setActionError(undefined);
    try {
      if (operation === "open_device") {
        await invoke("tray_sync", JSON.parse(traySettings));
        const path = await invoke<string | null>("launch_device", { serial: device.serial, hardware: device.hardware });
        if (path && (page === "devices" || selection.current === device.serial)) {
          setCapture({ name: deviceName(device), path, serial: device.serial });
        }
      } else {
        await invoke(operation, { serial: device.serial });
      }
    } catch (error) {
      if (page === "devices" || selection.current === device.serial) setActionError(errorKey(error));
    } finally {
      if (refreshing.current) await refreshing.current;
      await refresh();
      setPending((previous) => {
        const next = new Set(previous);
        next.delete(device.serial);
        return next;
      });
    }
  }

  async function changeConnection(device: Device) {
    if (pending.has(device.serial)) return;
    const serial = device.serial;
    const disconnecting = live.get(serial)?.status === "online";
    if ((device.connection === "wired" || disconnecting) && !usable(device)) return;
    setPending((previous) => new Set(previous).add(serial));
    setActionError(undefined);
    try {
      if (device.connection === "wired") {
        const wireless = await invoke<string>("switch_to_wireless", { serial, hardware: device.hardware });
        if (await restoreDevice(wireless, device.hardware ?? undefined)) selectDevice(wireless);
        return;
      }
      const addresses = loadMap<string>("wireless-endpoints");
      const address = disconnecting
        ? await invoke<string>("disconnect_wireless", { serial, hardware: device.hardware })
        : await invoke<string>("connect_wireless", { target: serial, savedAddress: addresses[serial] ?? null });
      addresses[serial] = address;
      saveLocalStorage("wireless-endpoints", JSON.stringify(addresses));
    } catch (error) {
      setActionError(errorKey(error));
    } finally {
      if (refreshing.current) await refreshing.current;
      await refresh();
      setPending((previous) => {
        const next = new Set(previous);
        next.delete(serial);
        return next;
      });
    }
  }

  const deletable = ordered.filter(canDelete).map((device) => device.serial);
  const selectedForDeletion = deletable.filter((serial) => checked.has(serial));
  const allChecked = deletable.length > 0 && selectedForDeletion.length === deletable.length;

  function requestDelete(serials: string[]) {
    setDeleteRequest(serials.flatMap((serial) => {
      const key = keyFor(serial);
      return key ? [{ serial, key }] : [];
    }));
  }

  return (
    <div className="window-shell" style={windowStyle} onKeyDown={(event) => {
      if (event.key === "Escape") { setPhoneMenu(false); setProfileSerial(undefined); setDeleteRequest(undefined); }
    }}>
      <div className="titlebar" data-tauri-drag-region>
        <span className="title-brand" data-tauri-drag-region>
          <img src="/app-logo.svg" alt="" draggable={false} />
          <span data-tauri-drag-region>{t("title")}</span>
        </span>
        <div className="title-actions">
          <IconButton icon="minimize" label={t("minimizeWindow")} onClick={() => void nativeWindow.minimize()} />
          <IconButton icon="maximize" label={t("maximizeWindow")} onClick={() => void nativeWindow.toggleMaximize()} />
          <IconButton icon="close" label={t(closeBehavior === "exit" ? "exitOnClose" : "closeConsole")} onClick={() => void nativeWindow.close()} />
        </div>
      </div>
      {resizeEdges.map((edge) => <div key={edge} className={`resize-edge resize-${edge}`} aria-hidden="true"
        onMouseDown={(event) => {
          if (event.button === 0) void nativeWindow.startResizeDragging(edge).catch(() => {});
        }} />)}
      <div className="app">
      <nav className="rail" aria-label={messages.title}>
        <div className="rail-links">
          <IconButton icon="devices" label={messages.devices} active={page === "devices"}
            onClick={() => { setPhoneMenu(false); setPage("devices"); }} />
          <IconButton icon="appWindows" label={t("appWindows")} active={page === "appWindows"}
            onClick={() => { setPhoneMenu(false); setActionError(undefined); setPage("appWindows"); }} />
          <div className="rail-tools" role="group" aria-label={t("tools")}>
            {toolSections.map(({ id, label, Icon }) => <button key={id} type="button" className="icon-button"
              aria-label={t(label)} data-tip={t(label)} aria-pressed={page === "tools" && toolSection === id}
              onClick={() => {
                setPhoneMenu(false);
                setActionError(undefined);
                setToolSection(id);
                setPage("tools");
              }}><Icon aria-hidden="true" /></button>)}
          </div>
        </div>
        <div className="phone-picker">
          <button type="button" className="icon-button phone-choice" aria-label={t("chooseActivePhone")}
            aria-expanded={phoneMenu} data-tip={target ? `${t("currentPhone")} · ${currentTitle}` : t("chooseActivePhone")}
            onClick={() => setPhoneMenu(!phoneMenu)}>
            <DeviceMark mark={target ? visibleMark(target.serial) : defaultMark}
              detected={target ? brandFor(target.serial)?.brand : undefined} />
          </button>
          {phoneMenu && <div className="phone-popover panel" role="group" aria-label={t("chooseActivePhone")}>
          {!ordered.length && <p>{t("noTarget")}</p>}
          {ordered.map((device) => {
            const name = deviceName(device);
            const label = `${name} · ${t(device.connection)} · ${statusLabel(device)}`;
            return <button type="button" key={device.serial} data-phone={device.serial} data-tip={label}
              className={`icon-button phone-choice ${usable(device) ? "" : "phone-offline"}`}
              aria-label={label} aria-pressed={target?.serial === device.serial} disabled={device.status === "online" && !device.hardware}
              onClick={() => selectDevice(device.serial)}>
              <DeviceMark mark={visibleMark(device.serial)} detected={brandFor(device.serial)?.brand} />
              <span className="phone-name">{name}<small>{t(device.connection)} · {statusLabel(device)}</small></span>
            </button>;
          })}
          </div>}
        </div>
        <IconButton icon="settings" label={messages.settings}
          active={page === "settings"} onClick={() => { setPhoneMenu(false); setPage("settings"); }} />
      </nav>
      <main className={page === "devices" ? "device-page" : undefined} onPointerDown={() => setPhoneMenu(false)}>
        <div className="page-content">
        {page === "devices" && hiddenDevices.length > 0 && <div className="panel hidden-device-notice">
          <span role="status">{t("hiddenDevicesDetected")} · {hiddenDevices.length}</span>
          <button type="button" onClick={() => setConnectionOpen(true)}>{t("viewHiddenDevices")}</button>
        </div>}
        {!connectionOpen && <ErrorToast message={actionError ? t(actionError)
          : page !== "settings" && page !== "appWindows" && listError ? t(listError) : undefined} dismiss={t("dismissNotice")} />}
        {page === "devices" && capture && <div className="panel hidden-device-notice">
          <span className="capture" role="status">{t("capturePath")} · {capture.name} · {capture.path}</span>
          <button type="button" disabled={["starting", "running", "stopping"].includes(merged.get(capture.serial)?.session ?? "")}
            onClick={() => void invoke("reveal_capture", { path: capture.path }).catch((error) => setActionError(errorKey(error)))}>
            {t("revealRecording")}
          </button>
        </div>}
        {page === "settings" ? (
          <div className="settings-layout settings-icon-layout">
            <nav className="section-sidebar" aria-label={t("settings")}>
              {([
                ["general", "generalSettings", Languages],
                ["appearance", "appearance", Palette],
                ["engine", "engineUpdates", PackageCheck],
                ["logs", "controlLogs", ScrollText],
              ] as const).map(([section, label, Glyph]) => <button type="button" key={section}
                className="icon-button" aria-label={t(label)} data-tip={t(label)}
                aria-pressed={settingsSection === section} onClick={() => setSettingsSection(section)}>
                <Glyph aria-hidden="true" />
              </button>)}
            </nav>
            <div className="section-content settings-stack">
              {settingsSection === "general" && <section className="panel controls settings-card">
                <h2>{t("generalSettings")}</h2>
                <div className="field-grid">
                  <label className="field"><span>{messages.language}</span>
                    <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
                      <option value="zh-CN" lang="zh-CN">简体中文</option>
                      <option value="en-US" lang="en-US">English</option>
                    </select>
                  </label>
                  <label className="field"><span>{t("closeBehavior")}</span>
                    <select value={closeBehavior} onChange={(event) => setCloseBehavior(event.target.value === "exit" ? "exit" : "tray")}>
                      <option value="tray">{t("closeConsole")}</option>
                      <option value="exit">{t("exitOnClose")}</option>
                    </select>
                  </label>
                </div>
              </section>}
              {settingsSection === "appearance" && <>
                <section className="panel controls settings-card">
                  <div className="settings-card-heading"><h2>{t("mainWindowAppearance")}</h2>
                    <IconButton icon="reset" label={t("resetAppearance")} onClick={() => { setWindowOpacity(88); setPanelOpacity(86); }} />
                  </div>
                  <div className="field-grid task-options">
                    <label className="field"><span>{t("windowOpacity")} · {windowOpacity}%</span>
                      <input type="range" min={20} max={100} value={windowOpacity}
                        onChange={(event) => setWindowOpacity(Number(event.target.value))} /></label>
                    <label className="field"><span>{t("panelOpacity")} · {panelOpacity}%</span>
                      <input type="range" min={20} max={100} value={panelOpacity}
                        onChange={(event) => setPanelOpacity(Number(event.target.value))} /></label>
                  </div>
                </section>
                <ControlAppearance t={t} locale={locale} />
                <MirrorAppearance t={t} />
              </>}
              {settingsSection === "engine" && <div ref={setEnginePanel} />}
              {settingsSection === "logs" && <ControlLog t={t} />}
            </div>
          </div>
        ) : page === "appWindows" ? (
          <AppWindowPanel key={`${selected}:${appDeviceKey}:${usable(target)}`} deviceKey={appDeviceKey}
            serial={usable(target) ? target?.serial : undefined} hardware={usable(target) ? target?.hardware ?? undefined : undefined}
            title={currentTitle} screen={target ? facts[target.serial]?.size : undefined} t={t} />
        ) : page === "tools" ? (
          <ToolPanel key={`${selected}:${appDeviceKey}:${usable(target)}`} section={toolSection}
            device={usable(target) ? target : undefined} profile={target ? profileFor(target.serial) : defaultProfile} t={t} refresh={refresh} />
        ) : (
          <>
            {ordered.length ? (
              <ul className="panel devices">
                {ordered.map((device) => {
                  const running = device.session === "running";
                  const busy = pending.has(device.serial) || device.session === "starting" || device.session === "stopping";
                  const canOpen = !busy && !(device.task && running) && usable(device);
                  return (
                    <li className={`device ${dragging === device.serial ? "dragging" : ""} ${dropTarget === device.serial && dragging !== device.serial
                      ? ordered.findIndex((entry) => entry.serial === dragging) < ordered.indexOf(device) ? "drop-after" : "drop-before" : ""}`}
                      key={device.serial} data-serial={device.serial}
                      onDoubleClick={(event) => {
                        if (!bulk && canOpen && !(event.target as Element).closest("button, input, form, .drag-handle")) void operate(device, "open_device");
                      }}>
                      {bulk ? <input type="checkbox" aria-label={`${t("selectDevices")} · ${deviceName(device)}`}
                        disabled={!canDelete(device)} checked={checked.has(device.serial)} onChange={(event) => {
                          const selected = event.target.checked;
                          setChecked((previous) => {
                            const next = new Set(previous);
                            if (selected) next.add(device.serial); else next.delete(device.serial);
                            return next;
                          });
                        }} /> : <span className="drag-handle" data-tip={t("dragDevice")} aria-hidden="true"
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          event.currentTarget.setPointerCapture(event.pointerId);
                          setDragging(device.serial);
                        }} onPointerMove={(event) => {
                          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                          const destination = document.elementFromPoint(event.clientX, event.clientY)
                            ?.closest<HTMLElement>(".device[data-serial]")?.dataset.serial;
                          setDropTarget(destination);
                        }} onPointerUp={(event) => {
                          const destination = document.elementFromPoint(event.clientX, event.clientY)
                            ?.closest<HTMLElement>(".device[data-serial]")?.dataset.serial;
                          if (destination) moveDevice(device.serial, ordered.findIndex((entry) => entry.serial === destination));
                          setDragging(undefined);
                          setDropTarget(undefined);
                        }} onLostPointerCapture={() => { setDragging(undefined); setDropTarget(undefined); }}><GripVertical aria-hidden="true" size={16} /></span>}
                      <DeviceMark mark={visibleMark(device.serial)} detected={brandFor(device.serial)?.brand} />
                      <div className="device-details">
                        <strong>{deviceName(device)}</strong>
                        <small>{messages[device.connection]}</small>
                      </div>
                      <span className={device.session === "failed" ? "status failure" : usable(device) ? "status online" : "status"}>
                        {device.status === "online" && !device.hardware ? statusLabel(device) :
                          running && device.task ? t(device.task) : device.session !== "idle" ? t(device.session) : statusLabel(device)}
                      </span>
                      {!bulk && <div className="actions">
                        {device.connection === "wired" && device.status === "online" && <IconButton
                          icon="wireless" label={t("connectViaWireless")} disabled={pending.has(device.serial) || !usable(device)}
                          onClick={() => void changeConnection(device)} />}
                        {device.connection === "wireless" && <IconButton
                          icon={device.status === "online" ? "disconnect" : "refresh"}
                          label={t(device.status === "online" ? "disconnectAction" : "reconnectAction")}
                          disabled={pending.has(device.serial) || !!listError || (device.status === "online" && !usable(device))}
                          onClick={() => void changeConnection(device)} />}
                        <IconButton icon="lock" label={t("lockDevice")} disabled={busy || !usable(device)}
                          onClick={() => void lockDevice(device)} />
                        <IconButton icon="profiles" label={t("deviceSettings")} disabled={!keyFor(device.serial)} onClick={() => openDeviceSettings(device)} />
                        {(!device.task || !running) && <IconButton icon={running ? "focus" : "open"} label={messages[running ? "focus" : "open"]}
                          disabled={!canOpen} onClick={() => void operate(device, "open_device")} />}
                        {(running || device.session === "stopping") && !["backgroundRecord", "audioRecord"].includes(device.task ?? "") && <IconButton icon="stop" label={messages.stop}
                          disabled={!running || busy} onClick={() => void operate(device, "stop_device")} />}
                        <IconButton icon="trash" label={t(canDelete(device) ? "deleteDevice" : "closeBeforeDelete")}
                          disabled={!canDelete(device)} onClick={() => requestDelete([device.serial])} />
                      </div>}
                    </li>
                  );
                })}
              </ul>
            ) : !listError && <p className="panel empty" role="status">{messages[loading ? "loading" : "empty"]}</p>}
          </>
        )}
        <EngineUpdate host={enginePanel} t={t} />
        {page === "devices" && configured && editing && <section className="panel shortcut-editor device-settings" role="dialog" aria-label={t("deviceSettings")}>
          <header className="device-settings-header"><h2>{t("deviceSettings")} · {deviceName(configured)}</h2>
            <div className="actions">
              <IconButton icon="refresh" label={t("refresh")} onClick={() => void refresh()} />
              <IconButton icon="reset" label={t("resetProfile")} onClick={() => saveProfile(editing.key, defaultProfile)} />
              <IconButton icon="close" label={t("cancel")} onClick={() => setProfileSerial(undefined)} />
            </div>
          </header>
          <div className="device-settings-layout">
            <nav className="device-settings-nav" aria-label={t("deviceSettings")}>
              {deviceSettingsSections.map(([section, Glyph]) => <button key={section} type="button"
                className="icon-button" aria-label={t(section)}
                aria-pressed={deviceSettingsSection === section} data-tip={t(section)}
                onClick={() => {
                  setDeviceSettingsSection(section);
                  setActionError(undefined);
                  if (deviceSettingsBody.current) deviceSettingsBody.current.scrollTop = 0;
                }}>
                <Glyph aria-hidden="true" />
              </button>)}
            </nav>
            <div className="device-settings-body" ref={deviceSettingsBody}>
              {deviceSettingsSection === "editDevice" ? <section className="device-settings-section">
                <h2>{t("editDevice")}</h2>
                <form onSubmit={(event) => { event.preventDefault(); saveAlias(); }} onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement) {
                    event.preventDefault();
                    saveAlias();
                  }
                }}>
                  <div className="field-grid">
                    <label className="field" data-tip={t("saveOnEnter")}><span>{t("rename")}</span>
                      <input placeholder={configured.model} value={editing.value}
                        onChange={(event) => setEditing({ ...editing, value: event.target.value })} /></label>
                    <label className="field"><span>{t("brandIcon")}</span>
                      <select value={editing.brand} onChange={(event) => {
                        const brand = event.target.value as Mark["brand"];
                        setEditing({ ...editing, brand });
                        saveDeviceMark(editing.key, { ...(deviceValue(editing.serial, marks) ?? defaultMark), brand });
                      }}>
                        <option value="auto">{t("automaticBrand")}</option>
                        {brands.map((brand) => <option value={brand} key={brand}>{t(brand)}</option>)}
                      </select></label>
                    <label className="field" data-tip={t("saveOnEnter")}><span>{t("numberBadge")}</span>
                      <input inputMode="numeric" maxLength={2} value={editing.badge}
                        onChange={(event) => setEditing({ ...editing, badge: event.target.value.replace(/[^0-9]/g, "") })} /></label>
                  </div>
                </form>
              </section> : deviceSettingsSection === "launchPreview" ? <LaunchArgumentsEditor
                key={configured.serial} args={currentProfile.extraArgs} t={t}
                update={(extraArgs) => saveProfile(editing.key, { ...currentProfile, extraArgs })}
                inspect={(args) => void previewProfile(args)}
                preview={preview?.serial === configured.serial && preview.title === deviceName(configured)
                  && JSON.stringify(preview.profile) === JSON.stringify(currentProfile)
                  ? preview.args : undefined} />
                : <ProfileEditor section={deviceSettingsSection} placementSerial={configured.serial}
                  serial={usable(configured) ? configured.serial : undefined}
                  hardware={usable(configured) ? configured.hardware ?? undefined : undefined}
                  sdk={facts[configured.serial]?.sdk} screen={facts[configured.serial]?.size} profile={currentProfile}
                  update={(profile) => saveProfile(editing.key, profile)} t={t} />}
            </div>
          </div>
        </section>}
        {deleteRequest && <section className="panel controls shortcut-editor delete-dialog" role="dialog" aria-label={t("deleteDevice")}>
          <h2>{t("deleteDevice")} · {deleteRequest.length}</h2>
          <p>{t("deleteDevicePrompt")}</p>
          <div className="form-actions">
            <button type="button" onClick={() => setDeleteRequest(undefined)}>{t("cancel")}</button>
            <button type="button" className="danger-button" onClick={deleteDevices}>{t("confirmDeviceDelete")}</button>
          </div>
        </section>}
        {connectionOpen && <ConnectionDialog t={t} refresh={refresh} onClose={() => setConnectionOpen(false)}
          restoreEntries={hiddenDevices}
          onRestore={restoreDevice} />}
        </div>
        {page === "devices" && <div className="device-page-actions">
          {bulk && <span className="selection-count" role="status">{t("selectedDevices")} · {selectedForDeletion.length}</span>}
          {bulk && <button type="button" disabled={!deletable.length}
            onClick={() => setChecked(new Set(allChecked ? [] : deletable))}>{t(allChecked ? "clearDeviceSelection" : "selectAllDevices")}</button>}
          {bulk && <IconButton icon="trash" label={t("deleteSelectedDevices")} disabled={!selectedForDeletion.length}
            onClick={() => requestDelete(selectedForDeletion)} />}
          <IconButton icon="selectDevices" label={t(bulk ? "cancelDeviceSelection" : "selectDevices")}
            active={bulk} disabled={!ordered.some(canDelete) && !bulk}
            onClick={() => { setBulk(!bulk); setChecked(new Set()); }} />
          <IconButton icon="addDevice" label={t("addDevice")} onClick={() => { setPhoneMenu(false); setConnectionOpen(true); }} />
          <IconButton icon="refresh" label={messages.refresh} onClick={() => void refresh()} />
        </div>}
      </main>
      </div>
    </div>
  );
}
