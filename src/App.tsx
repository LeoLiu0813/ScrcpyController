import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getInitialLocale, locales, type Locale, type Message } from "./locales";
import { deviceStorageKey, bindAlias } from "./deviceAliases";
import { AppWindowPanel, bindDeviceApps, defaultProfile, loadMap, ProfileEditor, ToolPanel, type Device, type Profile } from "./Workflows";
import ConnectionDialog from "./ConnectionDialog";
import { MirrorAppearance } from "./MirrorWindow";
import ErrorToast from "./ErrorToast";
import EngineUpdate from "./EngineUpdate";
import "./App.css";

const icons = {
  expandRail: "M3 4h18v16H3zM8 4v16m4-11 3 3-3 3",
  collapseRail: "M3 4h18v16H3zM8 4v16m8-11-3 3 3 3",
  devices: "M4 5h16v11H4zM9 20h6m-3-4v4",
  settings: "M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2m0-12-2 2m-8 8-2 2M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10",
  refresh: "M19 8a8 8 0 1 0 1 7m-1-11v5h-5",
  addDevice: "M5 3h9v18H5zM8 18h3m7-10v8m-4-4h8",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7",
  selectDevices: "M4 5h16v14H4zM8 12l3 3 5-6",
  disconnect: "M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 7-2m-4 6a4 4 0 0 1 3-1m0 5h.01m4-6 5 5m0-5-5 5",
  wireless: "M3 9a14 14 0 0 1 18 0M6 13a9 9 0 0 1 12 0M9 17a4 4 0 0 1 6 0m-3 3h.01",
  open: "M8 5l12 7-12 7z",
  focus: "M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5M9 12h6m-3-3v6",
  stop: "M6 6h12v12H6z",
  profiles: "M4 7h16M4 17h16M8 4v6m8 4v6",
  tools: "M14 6a4 4 0 0 0-5 5L4 16a2 2 0 0 0 3 3l5-5a4 4 0 0 0 5-5l-3 3-2-2z",
  rename: "m4 16 12-12 4 4L8 20H4zm10-10 4 4",
  reset: "M4 10a8 8 0 1 1 1 7M4 5v5h5",
  minimize: "M5 12h14",
  maximize: "M5 5h14v14H5z",
  close: "m6 6 12 12M18 6 6 18",
  appWindows: "M4 5h16v14H4zM4 9h16M9 13h6m-3-3v6",
};

const brands = ["generic", "oneplus", "xiaomi", "google", "samsung"] as const;
type Brand = typeof brands[number];
type Mark = { brand: Brand | "auto"; badge: string };
const defaultMark: Mark = { brand: "auto", badge: "" };
type DeviceFacts = { brand: Brand; manufacturer: string; size?: [number, number] };
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
    {brand === "generic" ? <svg viewBox="0 0 24 24"><path d="M7 3h10v18H7zM11 18h2" /></svg>
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
  return (
    <button type="button" className="icon-button" aria-label={label}
      aria-pressed={active} data-tip={label} disabled={disabled} onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={icons[icon]} /></svg>
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
  const [page, setPage] = useState<"devices" | "tools" | "appWindows" | "settings">("devices");
  const [profileSerial, setProfileSerial] = useState<string>();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => localStorage.getItem("nav-expanded") === "true");
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
  const [capture, setCapture] = useState<string>();
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
  const currentProfile = configured ? profiles[configured.serial] ?? defaultProfile : defaultProfile;
  const appDeviceKey = target && deviceStorageKey(target.serial, identities);
  const currentTitle = target ? deviceName(target) : "";

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

  async function previewProfile() {
    if (!configured) return;
    const title = deviceName(configured);
    setActionError(undefined);
    setPreview(undefined);
    try {
      const args = await invoke<string[]>("preview_profile", {
        serial: configured.serial, title, profile: currentProfile,
      });
      setPreview({ serial: configured.serial, profile: currentProfile, title, args });
    } catch (error) {
      setActionError(errorKey(error));
    }
  }

  function saveProfile(serial: string, profile: Profile) {
    const next = { ...profiles, [serial]: profile };
    localStorage.setItem("device-profiles", JSON.stringify(next));
    setProfiles(next);
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
    const nextMarks = { ...marks, [editing.serial]: { brand: editing.brand, badge: editing.badge } };
    localStorage.setItem("device-marks-v2", JSON.stringify(nextMarks));
    setMarks(nextMarks);
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
    devices: ordered.map((device) => ({
      serial: device.serial,
      name: deviceName(device),
      profile: profiles[device.serial] ?? defaultProfile,
    })),
    removed,
  });
  useEffect(() => {
    void invoke("tray_sync", JSON.parse(traySettings)).catch(() => {});
  }, [traySettings]);
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

  useEffect(() => {
    localStorage.setItem("nav-expanded", String(expanded));
  }, [expanded]);

  useEffect(() => localStorage.setItem("known-devices", JSON.stringify(known)), [known]);
  useEffect(() => localStorage.setItem("device-order", JSON.stringify(order)), [order]);
  useEffect(() => localStorage.setItem("selected-device", selected), [selected]);
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
            brand, manufacturer, size: match ? [Number(match[1]), Number(match[2])] : undefined,
          } }));
        }).catch(() => {}).finally(() => { factRequests.current.delete(serial); });
    }
  }, [devices, facts]);

  async function operate(device: Device, operation: "open_device" | "stop_device") {
    if (pending.has(device.serial)) return;
    setPending((previous) => new Set(previous).add(device.serial));
    setActionError(undefined);
    try {
      if (operation === "open_device") {
        const path = await invoke<string | null>(operation, {
          serial: device.serial,
          alias: deviceAlias(device.serial) ?? null,
          profile: profiles[device.serial] ?? defaultProfile,
        });
        if (path && (page === "devices" || selection.current === device.serial)) {
          setCapture(`${deviceName(device)} · ${path}`);
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
          <IconButton icon="close" label={t("closeConsole")} onClick={() => void nativeWindow.close()} />
        </div>
      </div>
      {resizeEdges.map((edge) => <div key={edge} className={`resize-edge resize-${edge}`} aria-hidden="true"
        onMouseDown={(event) => {
          if (event.button === 0) void nativeWindow.startResizeDragging(edge).catch(() => {});
        }} />)}
      <div className={expanded ? "app expanded" : "app"}>
      <nav className="rail" aria-label={messages.title}>
        <IconButton icon={expanded ? "collapseRail" : "expandRail"} label={messages[expanded ? "collapse" : "expand"]}
          active={expanded} onClick={() => setExpanded(!expanded)} />
        <IconButton icon="devices" label={messages.devices} text={expanded ? messages.devices : undefined}
          active={page === "devices"} onClick={() => setPage("devices")} />
        {(["appWindows", "tools"] as const).map((entry) => <IconButton key={entry} icon={entry}
          label={t(entry)} text={expanded ? t(entry) : undefined} active={page === entry}
          onClick={() => { setPhoneMenu(false); setActionError(undefined); setPage(entry); }} />)}
        <div className="rail-spacer" />
        <div className="phone-picker">
          <button type="button" className="icon-button phone-choice" aria-label={t("chooseActivePhone")}
            aria-expanded={phoneMenu} data-tip={target ? `${t("currentPhone")} · ${currentTitle}` : t("chooseActivePhone")}
            onClick={() => setPhoneMenu(!phoneMenu)}>
            <DeviceMark mark={target ? visibleMark(target.serial) : defaultMark}
              detected={target ? facts[target.serial]?.brand : undefined} />
            {expanded && <span className="phone-name">{currentTitle || t("chooseActivePhone")}</span>}
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
        <IconButton icon="settings" label={messages.settings} text={expanded ? messages.settings : undefined}
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
        {page !== "settings" && page !== "appWindows" && capture && <p className="capture" role="status">{t("capturePath")} · {capture}</p>}
        {page === "settings" ? (
          <><label className="panel setting">
            {messages.language}
            <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
              <option value="zh-CN" lang="zh-CN">简体中文</option>
              <option value="en-US" lang="en-US">English</option>
            </select>
          </label>
          <section className="panel controls appearance">
            <h2>{t("appearance")}</h2>
            <label className="field"><span>{t("windowOpacity")} · {windowOpacity}%</span>
              <input aria-label={t("windowOpacity")} type="range" min={20} max={100} value={windowOpacity}
                onChange={(event) => setWindowOpacity(Number(event.target.value))} /></label>
            <label className="field"><span>{t("panelOpacity")} · {panelOpacity}%</span>
              <input aria-label={t("panelOpacity")} type="range" min={20} max={100} value={panelOpacity}
                onChange={(event) => setPanelOpacity(Number(event.target.value))} /></label>
            <IconButton icon="reset" label={t("resetAppearance")} onClick={() => { setWindowOpacity(88); setPanelOpacity(86); }} />
          </section></>
        ) : page === "appWindows" ? (
          <AppWindowPanel key={`${selected}:${appDeviceKey}:${!listError && target?.status === "online"}`} deviceKey={appDeviceKey} serial={!listError && target?.status === "online" ? target.serial : undefined}
            title={currentTitle} screen={target ? facts[target.serial]?.size : undefined} t={t} />
        ) : page === "tools" ? (
          <><MirrorAppearance t={t} /><ToolPanel key={selected} device={listError ? undefined : target} t={t} refresh={refresh} /></>
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
                        }} onLostPointerCapture={() => { setDragging(undefined); setDropTarget(undefined); }}>⠿</span>}
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
                        <IconButton icon="profiles" label={t("deviceSettings")} onClick={() => openDeviceSettings(device)} />
                        {(!device.task || !running) && <IconButton icon={running ? "focus" : "open"} label={messages[running ? "focus" : "open"]}
                          disabled={!canOpen} onClick={() => void operate(device, "open_device")} />}
                        {(running || device.session === "stopping") && device.task !== "backgroundRecord" && <IconButton icon="stop" label={messages.stop}
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
        <EngineUpdate visible={page === "settings"} t={t} />
        {page === "devices" && configured && editing && <section className="panel shortcut-editor device-settings" role="dialog" aria-label={t("deviceSettings")}>
          <header className="device-settings-header"><h2>{t("deviceSettings")} · {deviceName(configured)}</h2>
            <div className="actions">
              <IconButton icon="refresh" label={t("refresh")} onClick={() => void refresh()} />
              <IconButton icon="reset" label={t("resetProfile")} onClick={() => saveProfile(configured.serial, defaultProfile)} />
              <IconButton icon="close" label={t("cancel")} onClick={() => setProfileSerial(undefined)} />
            </div>
          </header>
          <div className="device-settings-body">
            <section className="panel controls">
              <h2>{t("editDevice")}</h2>
              <form onSubmit={(event) => { event.preventDefault(); saveAlias(); }}>
                <div className="field-grid">
                  <label className="field" data-tip={t("aliasHint")}><span>{t("rename")}</span>
                    <input placeholder={configured.model} value={editing.value}
                      onChange={(event) => setEditing({ ...editing, value: event.target.value })} /></label>
                  <label className="field"><span>{t("brandIcon")}</span>
                    <select value={editing.brand} onChange={(event) => setEditing({ ...editing, brand: event.target.value as Mark["brand"] })}>
                      <option value="auto">{t("automaticBrand")}</option>
                      {brands.map((brand) => <option value={brand} key={brand}>{t(brand)}</option>)}
                    </select></label>
                  <label className="field"><span>{t("numberBadge")}</span>
                    <input inputMode="numeric" maxLength={2} value={editing.badge}
                      onChange={(event) => setEditing({ ...editing, badge: event.target.value.replace(/[^0-9]/g, "") })} /></label>
                </div>
                <div className="form-actions"><button type="submit" className="primary-action">{t("save")}</button></div>
              </form>
            </section>
            <ProfileEditor profile={currentProfile} update={(profile) => saveProfile(configured.serial, profile)} t={t} />
            <button type="button" data-tip={t("previewHint")} onClick={() => void previewProfile()}>{t("previewArgs")}</button>
            {preview?.serial === configured.serial && preview.profile === currentProfile &&
              <pre>{JSON.stringify(preview.args, null, 2)}</pre>}
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
