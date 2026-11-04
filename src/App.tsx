import { AudioLines, ClipboardList, Film, MonitorCog, Terminal, UserRound } from "lucide-react";
import ControlAppearance from "./ControlAppearance";
import { Monitor, Settings, RefreshCw, Smartphone, Trash2, ListChecks, WifiOff, Wifi,
  Play, Scan, Square, LockKeyhole, SlidersHorizontal, Pencil, RotateCcw, Minus, Maximize2, X,
  AppWindow, GripVertical, Languages, Palette, PackageCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getInitialLocale, locales, type Locale, type Message } from "./locales";
import { deviceStorageKey, bindAlias, legacyDeviceKeys } from "./deviceAliases";
import { AppWindowPanel, bindDeviceApps, defaultProfile, loadMap, ProfileEditor, ToolPanel, toolSections, type Device, type Profile, type ToolSection } from "./Workflows";
import ConnectionDialog from "./ConnectionDialog";
import { MirrorAppearance } from "./MirrorWindow";
import ErrorToast from "./ErrorToast";
import EngineUpdate from "./EngineUpdate";
import LaunchArgumentsEditor from "./LaunchArgumentsEditor";
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
type DeviceFacts = { brand: Brand; manufacturer: string; size?: [number, number]; sdk?: number };
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
  const [settingsSection, setSettingsSection] = useState<"general" | "appearance" | "engine">("general");
  const [enginePanel, setEnginePanel] = useState<HTMLDivElement | null>(null);
  const [page, setPage] = useState<"devices" | "tools" | "appWindows" | "settings">("devices");
  const [profileSerial, setProfileSerial] = useState<string>();
  const [deviceSettingsSection, setDeviceSettingsSection] = useState<DeviceSettingsSection>("editDevice");
  const deviceSettingsBody = useRef<HTMLDivElement>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [known, setKnown] = useState(() => loadMap<KnownDevice>("known-devices"));
  const [order, setOrder] = useState(() => readSerials("device-order"));
  const [removed, setRemoved] = useState(() => readSerials("removed-devices"));
  const removedRef = useRef(new Set(removed));
  const [bulk, setBulk] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [deleteRequest, setDeleteRequest] = useState<string[]>();
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<Message>();
  const [actionError, setActionError] = useState<Message>();
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [aliases, setAliases] = useState(() => loadMap<string>("device-aliases"));
  const pendingAliasEdits = useRef(new Map<string, string>());
  const [identities, setIdentities] = useState(() => loadMap<string>("device-identities"));
  const [profiles, setProfiles] = useState(() => loadMap<Profile>("device-profiles"));
  const [selected, setSelected] = useState(() => localStorage.getItem("selected-device") ?? "");
  const selection = useRef(selected);
  const [marks, setMarks] = useState(() => {
    if (localStorage.getItem("device-marks-v2")) return loadMap<Mark>("device-marks-v2");
    return Object.fromEntries(Object.entries(loadMap<Mark>("device-marks"))
      .map(([serial, mark]) => [serial, { ...defaultMark, badge: mark.badge }]));
  });
  const [facts, setFacts] = useState<Record<string, DeviceFacts>>({});
  const factRequests = useRef(new Set<string>());
  const [phoneMenu, setPhoneMenu] = useState(false);
  const [editing, setEditing] = useState<{ serial: string; value: string; originalName: string } & Mark>();
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
  for (const device of devices) merged.set(device.serial, device);
  for (const serial of removed) merged.delete(serial);
  const hiddenDevices = devices.filter((device) => removedRef.current.has(device.serial));
  const ordered = [...new Set([...order, ...merged.keys()])]
    .flatMap((serial) => { const device = merged.get(serial); return device ? [device] : []; });
  const target = selected ? merged.get(selected) : undefined;
  const nativeWindow = getCurrentWindow();
  const windowStyle = { "--window-opacity": `${windowOpacity}%`, "--panel-opacity": `${panelOpacity}%` } as CSSProperties;
  const configured = profileSerial ? merged.get(profileSerial) : undefined;
  const currentProfile = configured ? profileFor(configured.serial) : defaultProfile;
  const appDeviceKey = target && deviceStorageKey(target.serial, identities);
  const currentTitle = target ? deviceName(target) : "";

  function profileFor(serial: string): Profile {
    const hardware = identities[serial];
    const key = deviceStorageKey(serial, identities);
    const legacy = hardware && legacyDeviceKeys(serial, hardware, identities, Object.keys(profiles))
      .find((candidate) => profiles[candidate]);
    const saved = profiles[key] ?? (legacy ? profiles[legacy] : undefined);
    return saved ? { ...defaultProfile, ...saved } : defaultProfile;
  }

  function normalProfile(serial: string): Profile {
    return { ...profileFor(serial), camera: "", cameraId: "" };
  }

  function deviceAlias(serial: string) {
    return aliases[deviceStorageKey(serial, identities)];
  }

  function deviceName(device: Device) {
    return deviceAlias(device.serial) || device.model;
  }

  function canDelete(device: Device) {
    return !pending.has(device.serial) && ["idle", "failed"].includes(device.session);
  }

  function setRemovedDevices(next: string[]) {
    localStorage.setItem("removed-devices", JSON.stringify(next));
    removedRef.current = new Set(next);
    setRemoved(next);
  }

  function restoreDevice(serial: string) {
    if (!removedRef.current.has(serial)) return;
    setRemovedDevices([...removedRef.current].filter((entry) => entry !== serial));
    void refresh();
  }

  function deleteDevices() {
    const ids = (deleteRequest ?? []).filter((serial) => {
      const device = merged.get(serial);
      return device && canDelete(device);
    });
    setDeleteRequest(undefined);
    if (ids.length !== deleteRequest?.length) {
      setActionError("closeBeforeDelete");
      return;
    }
    if (!ids.length) return;
    const deleted = new Set(ids);
    setRemovedDevices([...new Set([...removedRef.current, ...ids])]);
    function withoutDeleted<T>(key: string, source = loadMap<T>(key)) {
      const next = { ...source };
      for (const id of ids) delete next[id];
      localStorage.setItem(key, JSON.stringify(next));
      return next;
    }
    setKnown(withoutDeleted("known-devices", known));
    setAliases(withoutDeleted<string>("device-aliases"));
    for (const id of ids) pendingAliasEdits.current.delete(id);
    setMarks(withoutDeleted("device-marks-v2", marks));
    setProfiles(withoutDeleted("device-profiles", profiles));
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
    setPreview(undefined);
    setActionError(undefined);
    setProfileSerial(device.serial);
    setDeviceSettingsSection("editDevice");
    const value = deviceAlias(device.serial) ?? "";
    setEditing({ serial: device.serial, value, originalName: value, ...(marks[device.serial] ?? defaultMark) });
  }

  function visibleMark(serial: string): Mark {
    const mark = marks[serial] ?? defaultMark;
    const manufacturer = facts[serial]?.manufacturer;
    const siblings = manufacturer ? ordered.filter((device) => facts[device.serial]?.manufacturer === manufacturer) : [];
    if (siblings.length < 2) return { ...mark, badge: "" };
    const assigned = new Map<string, string>();
    const used = new Set<string>();
    const stable = siblings.map((device) => device.serial).sort();
    for (const id of stable) {
      const badge = marks[id]?.badge;
      if (badge && !used.has(badge)) { assigned.set(id, badge); used.add(badge); }
    }
    let number = 1;
    for (const id of stable) {
      if (assigned.has(id)) continue;
      while (used.has(String(number))) number++;
      assigned.set(id, String(number++));
    }
    return { ...mark, badge: assigned.get(serial) ?? "" };
  }

  function selectDevice(serial: string) {
    setPhoneMenu(false);
    selection.current = serial;
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
    setOrder(ids);
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

  function saveProfile(serial: string, profile: Profile) {
    const next = { ...profiles, [deviceStorageKey(serial, identities)]: profile };
    localStorage.setItem("device-profiles", JSON.stringify(next));
    setProfiles(next);
  }

  function saveDeviceMark(serial: string, mark: Mark) {
    const next = { ...marks, [serial]: mark };
    localStorage.setItem("device-marks-v2", JSON.stringify(next));
    setMarks(next);
  }

  function saveAlias() {
    if (!editing) return;
    const value = editing.value.trim();
    if (Array.from(value).length > 60 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
      setActionError("invalidName");
      return;
    }
    if (value !== editing.originalName) {
      const next = loadMap<string>("device-aliases");
      const key = deviceStorageKey(editing.serial, loadMap<string>("device-identities"));
      if (key === editing.serial) pendingAliasEdits.current.set(editing.serial, value);
      if (value) next[key] = value;
      else delete next[key];
      localStorage.setItem("device-aliases", JSON.stringify(next));
      setAliases(next);
    }
    saveDeviceMark(editing.serial, { brand: editing.brand, badge: editing.badge });
    setEditing({ ...editing, value, originalName: value });
    setActionError(undefined);
  }

  const refresh = useCallback(() => {
    if (!refreshing.current) {
      refreshing.current = invoke<Device[]>("list_devices")
        .then((next) => {
          setDevices(next);
          const online = new Set(next.filter((device) => device.status === "online").map((device) => device.serial));
          setFacts((previous) => Object.keys(previous).every((serial) => online.has(serial))
            ? previous : Object.fromEntries(Object.entries(previous).filter(([serial]) => online.has(serial))));
          setListError(undefined);
          setKnown((previous) => {
            let result = previous;
            for (const { serial, model, connection } of next) {
              if (removedRef.current.has(serial)) continue;
              if (previous[serial]?.model === model && previous[serial]?.connection === connection) continue;
              if (result === previous) result = Object.assign(Object.create(null), previous);
              result[serial] = { serial, model, connection };
            }
            return result;
          });
          if (!selection.current) {
            const available = next.filter((device) => !removedRef.current.has(device.serial));
            selection.current = (available.find((device) => device.status === "online") ?? available[0])?.serial ?? "";
            setSelected(selection.current);
          }
        })
        .catch((error: unknown) => setListError(errorKey(error)))
        .finally(() => { refreshing.current = null; setLoading(false); });
    }
    return refreshing.current;
  }, []);

  const traySettings = JSON.stringify({
    english: locale === "en-US",
    exitOnClose: closeBehavior === "exit",
    devices: ordered.map((device) => ({
      serial: device.serial,
      name: deviceName(device),
      profile: normalProfile(device.serial),
    })),
    removed,
  });
  useEffect(() => {
    void invoke("tray_sync", JSON.parse(traySettings)).catch(() => {});
  }, [traySettings]);
  useEffect(() => {
    const listener = listen<string>("open-file-tools", ({ payload }) => {
      selectDevice(payload);
      setToolSection("files");
      setPage("tools");
    });
    return () => { void listener.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

  useEffect(() => {
    const listener = listen<string>("tray-device-error", ({ payload }) => setActionError(errorKey(payload)));
    return () => { void listener.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);

  useEffect(() => {
    localStorage.setItem("display-language", locale);
    document.documentElement.lang = locale;
    document.title = messages.title;
    void getCurrentWindow().setTitle(messages.title).catch(() => {});
  }, [locale, messages.title]);

  useEffect(() => localStorage.setItem("known-devices", JSON.stringify(known)), [known]);
  useEffect(() => localStorage.setItem("device-order", JSON.stringify(order)), [order]);
  useEffect(() => localStorage.setItem("selected-device", selected), [selected]);
  useEffect(() => localStorage.setItem("main-close-behavior", closeBehavior), [closeBehavior]);
  useEffect(() => localStorage.setItem("window-opacity", String(windowOpacity)), [windowOpacity]);
  useEffect(() => localStorage.setItem("panel-opacity", String(panelOpacity)), [panelOpacity]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 1200);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    for (const { serial, status } of devices) {
      if (status !== "online" || facts[serial] || factRequests.current.has(serial)) continue;
      factRequests.current.add(serial);
      void invoke<{ text: string; success: boolean }>("query_device", { serial, query: "deviceFacts" })
        .then(({ text, success }) => {
          if (!success) return;
          const hardware = text.match(/^controller-serial:([a-zA-Z0-9._-]{4,128})\s*$/m)?.[1];
          if (hardware && !/^(unknown|0+)$/i.test(hardware) && !removedRef.current.has(serial)) {
            const ids = loadMap<string>("device-identities");
            bindDeviceApps(serial, hardware, ids);
            const names = loadMap<string>("device-aliases");
            const pendingName = pendingAliasEdits.current.get(serial);
            const next = bindAlias(serial, hardware, ids, names, pendingName);
            pendingAliasEdits.current.delete(serial);
            if (ids[serial] !== hardware || next !== names) {
              ids[serial] = hardware;
              localStorage.setItem("device-aliases", JSON.stringify(next));
              localStorage.setItem("device-identities", JSON.stringify(ids));
              setAliases(next);
              setIdentities(ids);
              const name = next[deviceStorageKey(serial, ids)] ?? "";
              setEditing((current) => current?.serial === serial && current.value === current.originalName
                ? { ...current, value: name, originalName: name } : current);
            }
          }
          const manufacturer = text.split(/\r?\n/)[0].toLowerCase();
          const brand = brands.find((value) => manufacturer.includes(value)) ??
            (/redmi|poco/.test(manufacturer) ? "xiaomi" : "generic");
          const match = text.match(/Physical size:\s*(\d+)x(\d+)/);
          setFacts((previous) => ({ ...previous, [serial]: {
            brand, manufacturer, sdk: Number(text.match(/^controller-sdk:(\d+)\s*$/m)?.[1]) || undefined, size: match ? [Number(match[1]), Number(match[2])] : undefined,
          } }));
        }).catch(() => {}).finally(() => { factRequests.current.delete(serial); });
    }
  }, [devices, facts]);

  async function lockDevice(device: Device) {
    const serial = device.serial;
    if (pending.has(serial)) return;
    setActionError(undefined);
    setPending((previous) => new Set(previous).add(serial));
    try {
      await invoke("lock_device", { serial });
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
    if (pending.has(device.serial)) return;
    setPending((previous) => new Set(previous).add(device.serial));
    setActionError(undefined);
    try {
      if (operation === "open_device") {
        const path = await invoke<string | null>(operation, {
          serial: device.serial,
          alias: deviceAlias(device.serial) ?? null,
          profile: normalProfile(device.serial),
        });
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
    const disconnecting = devices.some((entry) => entry.serial === serial);
    setPending((previous) => new Set(previous).add(serial));
    setActionError(undefined);
    try {
      if (device.connection === "wired") {
        const wireless = await invoke<string>("switch_to_wireless", { serial });
        restoreDevice(wireless);
        selectDevice(wireless);
        return;
      }
      const addresses = loadMap<string>("wireless-endpoints");
      const address = disconnecting
        ? await invoke<string>("disconnect_wireless", { serial })
        : await invoke<string>("connect_wireless", { target: serial, savedAddress: addresses[serial] ?? null });
      addresses[serial] = address;
      localStorage.setItem("wireless-endpoints", JSON.stringify(addresses));
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
              detected={target ? facts[target.serial]?.brand : undefined} />
          </button>
          {phoneMenu && <div className="phone-popover panel" role="group" aria-label={t("chooseActivePhone")}>
          {!ordered.length && <p>{t("noTarget")}</p>}
          {ordered.map((device) => {
            const name = deviceName(device);
            const label = `${name} · ${t(device.connection)} · ${t(device.status)}`;
            return <button type="button" key={device.serial} data-phone={device.serial} data-tip={label}
              className={`icon-button phone-choice ${device.status === "online" ? "" : "phone-offline"}`}
              aria-label={label} aria-pressed={selected === device.serial} onClick={() => selectDevice(device.serial)}>
              <DeviceMark mark={visibleMark(device.serial)} detected={facts[device.serial]?.brand} />
              <span className="phone-name">{name}<small>{t(device.connection)} · {t(device.status)}</small></span>
            </button>;
          })}
          </div>}
        </div>
        <IconButton icon="settings" label={messages.settings}
          active={page === "settings"} onClick={() => setPage("settings")} />
      </nav>
      <main className={page === "devices" ? "device-page" : undefined} onPointerDown={() => setPhoneMenu(false)}>
        <div className="page-content">
        {page === "devices" && hiddenDevices.length > 0 && <div className="panel hidden-device-notice">
          <span role="status">{t("hiddenDevicesDetected")} · {hiddenDevices.length}</span>
          <button type="button" onClick={() => setConnectionOpen(true)}>{t("viewHiddenDevices")}</button>
        </div>}
        {!connectionOpen && page !== "settings" && page !== "appWindows" &&
          <ErrorToast message={actionError ? t(actionError) : listError ? t(listError) : undefined} dismiss={t("dismissNotice")} />}
        {page === "devices" && capture && <div className="panel hidden-device-notice">
          <span className="capture" role="status">{t("capturePath")} · {capture.name} · {capture.path}</span>
          <button type="button" disabled={["starting", "running", "stopping"].includes(merged.get(capture.serial)?.session ?? "")}
            onClick={() => void invoke("reveal_capture", { path: capture.path }).catch((error) => setActionError(errorKey(error)))}>
            {t("revealRecording")}
          </button>
        </div>}
        {page === "settings" ? (
          <div className="settings-layout">
            <nav className="section-sidebar" aria-label={t("settings")}>
              {([
                ["general", "generalSettings", Languages],
                ["appearance", "appearance", Palette],
                ["engine", "engineUpdates", PackageCheck],
              ] as const).map(([section, label, Glyph]) => <button type="button" key={section}
                aria-pressed={settingsSection === section} onClick={() => setSettingsSection(section)}>
                <Glyph size={17} aria-hidden="true" /><span>{t(label)}</span>
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
            </div>
          </div>
        ) : page === "appWindows" ? (
          <AppWindowPanel key={`${selected}:${appDeviceKey}:${!listError && target?.status === "online"}`} deviceKey={appDeviceKey} serial={!listError && target?.status === "online" ? target.serial : undefined}
            title={currentTitle} screen={target ? facts[target.serial]?.size : undefined} t={t} />
        ) : page === "tools" ? (
          <ToolPanel key={selected} section={toolSection}
            device={listError ? undefined : target} profile={target ? profileFor(target.serial) : defaultProfile} t={t} refresh={refresh} />
        ) : (
          <>
            {ordered.length ? (
              <ul className="panel devices">
                {ordered.map((device) => {
                  const running = device.session === "running";
                  const busy = pending.has(device.serial) || device.session === "starting" || device.session === "stopping";
                  const canOpen = !busy && !(device.task && running) &&
                    (running || (device.status === "online" && !listError));
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
                      <DeviceMark mark={visibleMark(device.serial)} detected={facts[device.serial]?.brand} />
                      <div className="device-details">
                        <strong>{deviceName(device)}</strong>
                        <small>{messages[device.connection]}</small>
                      </div>
                      <span className={device.session === "failed" ? "status failure" : running || device.status === "online" ? "status online" : "status"}>
                        {running && device.task ? t(device.task) : device.session !== "idle" ? t(device.session) : t(device.status)}
                      </span>
                      {!bulk && <div className="actions">
                        {device.connection === "wired" && device.status === "online" && <IconButton
                          icon="wireless" label={t("connectViaWireless")} disabled={pending.has(device.serial) || !!listError}
                          onClick={() => void changeConnection(device)} />}
                        {device.connection === "wireless" && <IconButton
                          icon={devices.some((entry) => entry.serial === device.serial) ? "disconnect" : "refresh"}
                          label={t(devices.some((entry) => entry.serial === device.serial) ? "disconnectAction" : "reconnectAction")}
                          disabled={pending.has(device.serial) || !!listError} onClick={() => void changeConnection(device)} />}
                        <IconButton icon="lock" label={t("lockDevice")} disabled={busy || device.status !== "online" || !!listError}
                          onClick={() => void lockDevice(device)} />
                        <IconButton icon="profiles" label={t("deviceSettings")} onClick={() => openDeviceSettings(device)} />
                        {(!device.task || !running) && <IconButton icon={running ? "focus" : "open"} label={messages[running ? "focus" : "open"]}
                          disabled={!canOpen} onClick={() => void operate(device, "open_device")} />}
                        {(running || device.session === "stopping") && !["backgroundRecord", "audioRecord"].includes(device.task ?? "") && <IconButton icon="stop" label={messages.stop}
                          disabled={!running || busy} onClick={() => void operate(device, "stop_device")} />}
                        <IconButton icon="trash" label={t(canDelete(device) ? "deleteDevice" : "closeBeforeDelete")}
                          disabled={!canDelete(device)} onClick={() => setDeleteRequest([device.serial])} />
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
              <IconButton icon="reset" label={t("resetProfile")} onClick={() => saveProfile(configured.serial, defaultProfile)} />
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
                        saveDeviceMark(editing.serial, { ...(marks[editing.serial] ?? defaultMark), brand });
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
                update={(extraArgs) => saveProfile(configured.serial, { ...currentProfile, extraArgs })}
                inspect={(args) => void previewProfile(args)}
                preview={preview?.serial === configured.serial && preview.title === deviceName(configured)
                  && JSON.stringify(preview.profile) === JSON.stringify(currentProfile)
                  ? preview.args : undefined} />
                : <ProfileEditor section={deviceSettingsSection} placementSerial={configured.serial}
                  serial={configured.status === "online" ? configured.serial : undefined}
                  sdk={facts[configured.serial]?.sdk} screen={facts[configured.serial]?.size} profile={currentProfile}
                  update={(profile) => saveProfile(configured.serial, profile)} t={t} />}
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
            onClick={() => setDeleteRequest(selectedForDeletion)} />}
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
