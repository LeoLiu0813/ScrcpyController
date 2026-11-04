import { flushSync } from "react-dom";
import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { getInitialLocale, locales, type Message } from "./locales";
import { deviceStorageKey } from "./deviceAliases";
import { loadMap, type Shortcut } from "./Workflows";
import "./MirrorWindow.css";

const icons = {
  back: "M20 12H4m7-7-7 7 7 7",
  home: "m3 11 9-8 9 8M6 10v10h12V10m-8 10v-6h4v6",
  recents: "M4 8h13v12H4zM8 8V4h12v12h-3",
  volumeUp: "M3 9h4l5-4v14l-5-4H3zM17 9v6m-3-3h6",
  volumeDown: "M3 9h4l5-4v14l-5-4H3zM15 12h6",
  screenshot: "M4 7h4l2-3h4l2 3h4v13H4zM15 13a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  fullscreen: "M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5",
  notifications: "M5 17h14l-2-4V9a5 5 0 0 0-10 0v4zM10 21h4",
  quickSettings: "M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z",
  screenPower: "M5 11h14v9H5zM8 11V8a4 4 0 0 1 8 0v3m-4 4v2",
  screenOff: "M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm4 15h2M3 3l18 18",
  rotate: "M19 8a8 8 0 0 0-13-2l-2 2m0-5v5h5m-4 8a8 8 0 0 0 13 2l2-2m0 5v-5h-5",
  actual: "M4 5h16v14H4zm4 4h8v6H8z",
  fit: "M3 5h18v14H3zm4 7h10m-7-3-3 3 3 3m4-6 3 3-3 3",
  pause: "M9 5v14m6-14v14",
  resetVideo: "M20 10a8 8 0 1 0-1 7m1-13v6h-6",
  copyScreenshot: "M8 8h12v12H8zM4 16V4h12",
  captureFolder: "M3 6h7l2 2h9v12H3z",
  paste: "M8 5H5v15h14V5h-3M8 3h8v5H8zm1 9h6m-6 4h6",
} as const;
type Action = keyof typeof icons;
type Zone = "rail" | "more";
type Layout = {
  opacity: number; visible: boolean; rail: Action[]; more: Action[];
  buttonColor: string; buttonOpacity: number; frameBorder: number; pictureRadius: number;
};
type MirrorInfo = [title: string, width: number, height: number, serial: string, virtual: boolean, follow: boolean];
const pinIcon = "M9 3h6l-1 6 4 4v2H6v-2l4-4zM12 15v6";
const appIcon = "M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z";

const initial: Layout = {
  opacity: 88, visible: true, buttonColor: "#2a2b36", buttonOpacity: 100, frameBorder: 3, pictureRadius: 5,
  rail: ["back", "home", "recents", "volumeUp", "volumeDown", "screenshot", "fullscreen"],
  more: ["notifications", "quickSettings", "screenPower", "screenOff", "rotate", "actual", "fit",
    "pause", "resetVideo", "copyScreenshot", "captureFolder", "paste"],
};
const storageKey = "mirror-window-layout";
function readLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<Layout> | null;
    if (!saved) return initial;
    const seen = new Set<Action>();
    function valid(items: unknown): Action[] {
      if (!Array.isArray(items)) return [];
      return items.filter((item): item is Action => {
        if (typeof item !== "string" || !Object.prototype.hasOwnProperty.call(icons, item) || seen.has(item as Action)) return false;
        seen.add(item as Action);
        return true;
      });
    }
    const rail = valid(saved.rail);
    const more = valid(saved.more);
    more.push(...[...initial.rail, ...initial.more].filter((action) => !seen.has(action)));
    return {
      opacity: typeof saved.opacity === "number" && saved.opacity >= 20 && saved.opacity <= 100 ? saved.opacity : initial.opacity,
      visible: saved.visible !== false,
      frameBorder: typeof saved.frameBorder === "number" && Number.isInteger(saved.frameBorder)
        && saved.frameBorder >= 0 && saved.frameBorder <= 12 ? saved.frameBorder : initial.frameBorder,
      pictureRadius: typeof saved.pictureRadius === "number" && Number.isInteger(saved.pictureRadius)
        && saved.pictureRadius >= 0 && saved.pictureRadius <= 24 ? saved.pictureRadius : initial.pictureRadius,
      buttonColor: typeof saved.buttonColor === "string" && /^#[0-9a-f]{6}$/i.test(saved.buttonColor)
        ? saved.buttonColor : initial.buttonColor,
      buttonOpacity: typeof saved.buttonOpacity === "number" && saved.buttonOpacity >= 0 && saved.buttonOpacity <= 100
        ? saved.buttonOpacity : initial.buttonOpacity,
      rail, more,
    };
  } catch { return initial; }
}
function saveLayout(layout: Layout) {
  localStorage.setItem(storageKey, JSON.stringify(layout));
  window.dispatchEvent(new Event(storageKey));
}
function useLayout() {
  const [layout, setLayout] = useState(readLayout);
  useEffect(() => {
    const sync = () => setLayout(readLayout());
    window.addEventListener("storage", sync);
    window.addEventListener(storageKey, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(storageKey, sync);
    };
  }, []);
  return layout;
}

export function MirrorAppearance({ t }: { t: (key: Message) => string }) {
  const layout = useLayout();
  return <section className="panel controls">
    <h2>{t("mirrorAppearance")}</h2>
    <div className="tool-row">
      <label className="field">
        <span>{t("windowOpacity")} · {layout.opacity}%</span>
        <input type="range" min="20" max="100" value={layout.opacity}
          onChange={(event) => saveLayout({ ...readLayout(), opacity: Number(event.target.value) })} />
      </label>
      <label className="field">
        <span>{t("mirrorButtonColor")}</span>
        <input className="mirror-color-input" type="color" value={layout.buttonColor}
          onChange={(event) => saveLayout({ ...readLayout(), buttonColor: event.target.value })} />
      </label>
      <label className="field">
        <span>{t("mirrorButtonOpacity")} · {layout.buttonOpacity}%</span>
        <input type="range" min="0" max="100" value={layout.buttonOpacity}
          onChange={(event) => saveLayout({ ...readLayout(), buttonOpacity: Number(event.target.value) })} />
      </label>
      <label className="field">
        <span>{t("mirrorBackgroundInset")} · {layout.frameBorder} {t("mirrorPixelUnit")}</span>
        <input type="range" min="0" max="12" value={layout.frameBorder}
          onChange={(event) => saveLayout({ ...readLayout(), frameBorder: Number(event.target.value) })} />
      </label>
      <label className="field">
        <span>{t("mirrorPictureRadius")} · {layout.pictureRadius} {t("mirrorPixelUnit")}</span>
        <input type="range" min="0" max="24" value={layout.pictureRadius}
          onChange={(event) => saveLayout({ ...readLayout(), pictureRadius: Number(event.target.value) })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={layout.visible}
          onChange={(event) => saveLayout({ ...readLayout(), visible: event.target.checked })} />
        {t("mirrorToolbarVisible")}
      </label>
      <button type="button" onClick={() => saveLayout({ ...readLayout(), rail: initial.rail, more: initial.more })}>
        {t("mirrorResetLayout")}
      </button>
    </div>
  </section>;
}

function Icon({ path }: { path: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>;
}

type Drop = { zone: Zone; before?: Action; after?: boolean };

type ToolbarRequest = { id: number; operation: string; args: string[] };
const menuWidth = 64;
const sidebarWidth = 53;
const minimumWidth = 160;

export default function MirrorWindow() {
  const [shell] = useState(getCurrentWindow);
  const [locale, setLocale] = useState(getInitialLocale);
  const [info, setInfo] = useState<MirrorInfo>();
  const [deviceTitle, setDeviceTitle] = useState<string>();
  const [fps, setFps] = useState<number | null>(null);
  const [lockedWidth, setLockedWidth] = useState<number>();
  const [lockedPicture, setLockedPicture] = useState<[number, number]>();
  const changingSidebar = useRef(false);
  const [apps, setApps] = useState<Shortcut[]>([]);
  const [appIcons, setAppIcons] = useState<Record<string, string>>({});
  const [launchingApp, setLaunchingApp] = useState<string>();
  const iconRequests = useRef(new Set<string>());
  const [more, setMore] = useState(false);
  const [outside, setOutside] = useState(false);
  const extension = useRef<{ left: number; expandedLeft: number }>(undefined);
  const menuPending = useRef(false);
  const priming = useRef(true);
  const inputReady = useRef(false);
  const [ready, setReady] = useState(false);
  const saving = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cliHandler = useRef<(command: ToolbarRequest) => Promise<unknown>>(async () => null);
  const [dragging, setDragging] = useState<Action>();
  const [insertion, setInsertion] = useState<Drop>();
  const dragRef = useRef<Action>(undefined);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const viewport = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [top, setTop] = useState(false);
  const [sidebarOverride, setSidebarOverride] = useState<boolean>();
  const [landscape, setLandscape] = useState(false);
  const [paused, setPaused] = useState(false);
  const [screenOff, setScreenOff] = useState(false);
  const [caption, setCaption] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const layout = useLayout();
  const pictureStartInset = fullscreen ? layout.frameBorder : Math.max(4, layout.frameBorder);
  const picturePadding = pictureStartInset + layout.frameBorder;
  const sidebarEnabled = sidebarOverride ?? layout.visible;
  const t = (key: Message) => locales[locale][key];

  useEffect(() => {
    const syncLocale = () => setLocale(getInitialLocale());
    window.addEventListener("storage", syncLocale);
    const bridge = listen<ToolbarRequest>(`mirror-cli-request-${shell.label}`, ({ payload }) => {
      void cliHandler.current(payload).then(
        (result) => emit(`mirror-cli-response-${payload.id}`, { ok: true, result }),
        (error: unknown) => emit(`mirror-cli-response-${payload.id}`, {
          ok: false, error: typeof error === "string" ? error : "mirrorActionFailed",
        }),
      );
    });
    void shell.isFullscreen().then(setFullscreen);
    void shell.isAlwaysOnTop().then(setTop);
    invoke<MirrorInfo>("mirror_info").then(setInfo).catch(() => setError("mirrorFrameFailed"));
    return () => {
      window.removeEventListener("storage", syncLocale);
      void bridge.then((unlisten) => unlisten());
    };
  }, []);

  const serial = info?.[4] ? undefined : info?.[3];
  const windowTitle = deviceTitle ?? info?.[0];
  useEffect(() => {
    if (!serial) return;
    const sync = () => {
      const key = deviceStorageKey(serial, loadMap<string>("device-identities"));
      const name = loadMap<string>("device-aliases")[key]
        || loadMap<{ model: string }>("known-devices")[serial]?.model;
      setDeviceTitle(name);
    };
    sync();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [serial]);
  useEffect(() => {
    if (windowTitle) void shell.setTitle(windowTitle).catch(() => {});
  }, [shell, windowTitle]);
  useEffect(() => {
    if (!info) return;
    let active = true;
    const poll = () => {
      void invoke<number | null>("mirror_fps").then((count) => { if (active) setFps(count); }).catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [info]);
  useEffect(() => {
    if (!serial) return;
    const sync = () => {
      const key = deviceStorageKey(serial, loadMap<string>("device-identities"));
      setApps(loadMap<Shortcut[]>("phone-app-shortcuts")[key] ?? []);
      setAppIcons(loadMap<Record<string, string>>("phone-shortcut-icons")[key] ?? {});
    };
    sync();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [serial]);

  useEffect(() => {
    if (!serial) return;
    for (const { app } of apps) {
      if (appIcons[app.package] || iconRequests.current.has(app.package)) continue;
      iconRequests.current.add(app.package);
      void invoke<string>("app_icon", { serial, package: app.package }).then((icon) => {
        const cache = loadMap<Record<string, string>>("phone-shortcut-icons");
        const key = deviceStorageKey(serial, loadMap<string>("device-identities"));
        cache[key] = { ...cache[key], [app.package]: icon };
        setAppIcons(cache[key]);
        try { localStorage.setItem("phone-shortcut-icons", JSON.stringify(cache)); } catch { /* 图标仍在当前窗口显示。 */ }
      }).catch(() => {});
    }
  }, [serial, apps, appIcons]);

  async function launchShortcut(shortcut: Shortcut) {
    if (!info || launchingApp) return;
    setError("");
    setLaunchingApp(shortcut.app.package);
    try {
      await invoke("open_app_window", {
        serial: info[3], package: shortcut.app.package,
        title: `${shortcut.app.name || shortcut.app.package} · ${windowTitle ?? info[0]}`,
        display: shortcut.display,
      });
    } catch (reason) {
      setError(typeof reason === "string" && Object.prototype.hasOwnProperty.call(locales[locale], reason)
        ? reason : "appWindowFailed");
      throw reason;
    } finally { setLaunchingApp(undefined); }
  }

  function tip(label: string) {
    return {
      "aria-label": label, "data-mirror-tip": "",
      onPointerEnter: () => setCaption(label), onPointerLeave: () => setCaption(""),
      onFocus: () => setCaption(label), onBlur: () => setCaption(""),
    };
  }

  async function togglePin() {
    const next = !await shell.isAlwaysOnTop();
    await shell.setAlwaysOnTop(next);
    setTop(next);
    setCaption((current) => current === t(next ? "mirrorPin" : "mirrorUnpin") ? t(next ? "mirrorUnpin" : "mirrorPin") : current);
    return next;
  }

  useEffect(() => {
    if (!viewport.current || !info) return;
    let frame = 0;
    let stopped = false;
    let sending = false;
    let dirty = false;
    let last = "";
    const prime = async () => {
      if (!priming.current) return;
      try {
        if (!await shell.isFullscreen() && !await shell.isMaximized()) {
          const size = await shell.innerSize();
          const frame = document.querySelector(".mirror-shell")?.getBoundingClientRect();
          if (frame) flushSync(() => setLockedWidth(frame.width));
          const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const waitSize = async (width: number) => {
            const deadline = performance.now() + 450;
            while (!stopped && performance.now() < deadline) {
              const current = await shell.innerSize();
              if (current.width === width && current.height === size.height) return;
              await nextFrame();
            }
          };
          try {
            await shell.setSize(new PhysicalSize(size.width + 1, size.height));
            await waitSize(size.width + 1);
            await shell.setSize(size);
            await waitSize(size.width);
            await nextFrame();
          } finally { if (!stopped) setLockedWidth(undefined); }
        }
        if (!stopped) {
          inputReady.current = await invoke<boolean>("mirror_prepare_input").catch(() => false);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      } finally {
        priming.current = false;
        if (!stopped) setReady(true);
      }
    };
    const update = () => {
      dirty = true;
      if (frame || sending || stopped) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const surface = viewport.current;
        if (!surface || stopped) return;
        const rect = surface.getBoundingClientRect();
        const pixels = (n: number) => Math.round(n * window.devicePixelRatio);
        const ratio = landscape ? info[2] / info[1] : info[1] / info[2];
        const width = info[5] ? rect.width : Math.min(rect.width, rect.height * ratio);
        const height = info[5] ? rect.height : Math.min(rect.height, rect.width / ratio);
        const bounds = {
          x: pixels(rect.x + (rect.width - width) / 2),
          y: pixels(rect.y + (rect.height - height) / 2),
          width: pixels(width), height: pixels(height),
          radius: pixels(layout.pictureRadius),
        };
        const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height},${bounds.radius}`;
        dirty = false;
        if (key === last) return;
        last = key;
        sending = true;
        void invoke("mirror_position", { bounds }).then(prime).catch(() => {
          last = "";
          if (!stopped) setError("mirrorFrameFailed");
        }).finally(() => {
          sending = false;
          if (dirty && !stopped) update();
        });
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(viewport.current);
    window.addEventListener("resize", update);
    update();
    return () => {
      stopped = true;
      observer.disconnect();
      window.removeEventListener("resize", update);
      cancelAnimationFrame(frame);
    };
  }, [info, landscape, layout.pictureRadius]);

  async function savePlacement() {
    if (priming.current || menuPending.current || extension.current) return;
    await invoke("mirror_save_placement");
  }

  useEffect(() => {
    if (!ready) return;
    const queue = () => {
      if (priming.current || menuPending.current || extension.current) return;
      clearTimeout(saving.current);
      saving.current = setTimeout(() => void savePlacement().catch(() => {}), 220);
    };
    const listeners = [shell.onMoved(queue), shell.onResized(queue), shell.onFocusChanged(({ payload }) => {
      if (payload && !inputReady.current) {
        void invoke<boolean>("mirror_prepare_input").then((focused) => { inputReady.current = focused; }).catch(() => {});
      }
    })];
    return () => {
      clearTimeout(saving.current);
      for (const listener of listeners) void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [ready, shell]);

  async function changeMore(open: boolean) {
    if ((open && busy) || open === more) return;
    await changeRightPanel(open, menuWidth, setMore);
  }

  async function changeRightPanel(open: boolean, panelWidth: number, setOpen: (open: boolean) => void) {
    if (priming.current || menuPending.current) return;
    menuPending.current = true;
    const frame = document.querySelector(".mirror-shell");
    const widthBefore = frame?.getBoundingClientRect().width;
    const waitWidth = async (width: number) => {
      const deadline = performance.now() + 450;
      while (Math.abs(innerWidth - width) > 1 && performance.now() < deadline) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    };
    try {
      if (open && !fullscreen && !await shell.isMaximized()) {
        const [size, position, monitor, scale] = await Promise.all([
          shell.innerSize(), shell.outerPosition(), currentMonitor(), shell.scaleFactor(),
        ]);
        const width = Math.round(panelWidth * scale);
        const right = monitor ? monitor.workArea.position.x + monitor.workArea.size.width : position.x + size.width + width;
        const expandedLeft = Math.max(monitor?.workArea.position.x ?? position.x, Math.min(position.x, right - size.width - width));
        if (!monitor || size.width + width <= monitor.workArea.size.width) {
          flushSync(() => setLockedWidth(widthBefore));
          if (expandedLeft !== position.x) await shell.setPosition(new PhysicalPosition(expandedLeft, position.y));
          try {
            await shell.setSize(new PhysicalSize(size.width + width, size.height));
            await waitWidth((size.width + width) / scale);
          } catch (error) {
            if (expandedLeft !== position.x) await shell.setPosition(position);
            throw error;
          }
          extension.current = { left: position.x, expandedLeft };
          flushSync(() => { setOutside(true); setOpen(true); });
          return;
        }
      } else if (!open && extension.current) {
        const saved = extension.current;
        const [size, position, scale] = await Promise.all([shell.innerSize(), shell.outerPosition(), shell.scaleFactor()]);
        flushSync(() => setLockedWidth(widthBefore));
        const width = Math.max(Math.round(minimumWidth * scale), size.width - Math.round(panelWidth * scale));
        await shell.setSize(new PhysicalSize(width, size.height));
        await waitWidth(width / scale);
        flushSync(() => { setOpen(false); setOutside(false); });
        extension.current = undefined;
        if (position.x === saved.expandedLeft && saved.left !== position.x) {
          await shell.setPosition(new PhysicalPosition(saved.left, position.y)).catch(() => {});
        }
      }
      setOpen(open);
    } finally {
      if (widthBefore !== undefined) {
        requestAnimationFrame(() => requestAnimationFrame(() => setLockedWidth(undefined)));
      }
      setCaption("");
      menuPending.current = false;
    }
  }

  async function escape() {
    if (more) await changeMore(false);
    if (fullscreen) {
      await shell.setFullscreen(false);
      setFullscreen(false);
      setReveal(false);
    }
  }

  useEffect(() => setSidebarOverride(undefined), [layout.visible]);
  useEffect(() => {
    if (!sidebarEnabled && more) void changeMore(false).catch(() => setError("mirrorFrameFailed"));
  }, [sidebarEnabled, more]);

  async function toggleSidebar() {
    if (changingSidebar.current || menuPending.current || priming.current || busy) return sidebarEnabled;
    changingSidebar.current = true;
    const next = !sidebarEnabled;
    try {
      if (more) await changeMore(false);
      if (!info || !viewport.current || fullscreen || await shell.isMaximized()) {
        setSidebarOverride(next);
        return next;
      }
      const box = viewport.current.getBoundingClientRect();
      const frame = document.querySelector(".mirror-shell")?.getBoundingClientRect();
      const ratio = landscape ? info[2] / info[1] : info[1] / info[2];
      const width = info[5] ? box.width : Math.min(box.width, box.height * ratio);
      const height = info[5] ? box.height : Math.min(box.height, box.width / ratio);
      const [scale, origin] = await Promise.all([shell.scaleFactor(), shell.outerPosition()]);
      const target = new PhysicalSize(
        Math.round((width + picturePadding + (next ? sidebarWidth : 0)) * scale),
        Math.round((height + (frame?.height ?? innerHeight) - box.height) * scale),
      );
      const dx = Math.round((box.x + (box.width - width) / 2) * scale) - Math.round(pictureStartInset * scale);
      const dy = Math.round((box.y + (box.height - height) / 2) * scale) - Math.round(box.y * scale);
      flushSync(() => { setLockedPicture([width, height]); setSidebarOverride(next); });
      try {
        await Promise.all([
          shell.setSize(target),
          dx || dy ? shell.setPosition(new PhysicalPosition(origin.x + dx, origin.y + dy)) : Promise.resolve(),
        ]);
        const deadline = performance.now() + 450;
        while (Math.abs(innerWidth * scale - target.width) > 1 && performance.now() < deadline) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      } catch (error) {
        setSidebarOverride(sidebarEnabled);
        throw error;
      }
      return next;
    } finally {
      setLockedPicture(undefined);
      setCaption("");
      changingSidebar.current = false;
    }
  }

  useEffect(() => {
    const native = listen(`mirror-escape-${shell.label}`, () => { void escape().catch(() => setError("mirrorActionFailed")); });
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") void escape().catch(() => setError("mirrorActionFailed")); };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      void native.then((unlisten) => unlisten());
    };
  }, [fullscreen, more, shell]);

  const buttonLabel = (action: Action): string => {
    if (action === "pause" && paused) return t("mirrorResume");
    if (action === "screenOff" && screenOff) return t("mirrorScreenOn");
    return t((`mirror_${action}`) as Message);
  };

  async function act(action: Action) {
    if (dragRef.current || busy) throw "mirrorActionFailed";
    setError("");
    setBusy(true);
    try {
      if (action === "fullscreen") {
        if (more) await changeMore(false);
        await shell.setFullscreen(!fullscreen);
        setFullscreen(!fullscreen);
        setReveal(false);
        setMore(false);
      } else if (action === "actual" || action === "fit") {
        if (!info || !viewport.current) return;
        if (more) await changeMore(false);
        const box = viewport.current.getBoundingClientRect();
        const ratio = landscape ? info[2] / info[1] : info[1] / info[2];
        const width = action === "actual" ? info[landscape ? 2 : 1] / devicePixelRatio : Math.min(box.width, box.height * ratio);
        const shellBox = document.querySelector(".mirror-shell")?.getBoundingClientRect();
        const scale = await shell.scaleFactor();
        await shell.setSize(new PhysicalSize(
          Math.round((width + (shellBox?.width ?? innerWidth) - box.width) * scale),
          Math.round((width / ratio + (shellBox?.height ?? innerHeight) - box.height) * scale),
        ));
      } else {
        const result = await invoke("mirror_action", { action:
          action === "pause" && paused ? "resume" : action === "screenOff" && screenOff ? "screenOn" : action,
        });
        if (action === "pause") setPaused(!paused);
        if (action === "screenOff") setScreenOff(!screenOff);
        if (action === "rotate") setLandscape(!landscape);
        return result;
      }
    } catch (reason) {
      setError(typeof reason === "string" && Object.prototype.hasOwnProperty.call(locales[locale], reason) ? reason : "mirrorActionFailed");
      throw reason;
    } finally { setBusy(false); }
  }

  function dragEnd() {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = undefined;
    dragRef.current = undefined;
    setDragging(undefined);
    setInsertion(undefined);
  }
  function dragOver(event: DragEvent, target: Drop) {
    if (!dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setInsertion(target);
  }
  function drop(event: DragEvent, target: Drop) {
    const action = dragRef.current;
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (target.before !== action) {
      const current = readLayout();
      const next = { ...current, rail: current.rail.filter((item) => item !== action),
        more: current.more.filter((item) => item !== action) };
      const index = target.before ? next[target.zone].indexOf(target.before) : -1;
      next[target.zone].splice(index < 0 ? next[target.zone].length : index + Number(!!target.after), 0, action);
      saveLayout(next);
    }
    dragEnd();
  }
  const divider = (action: Action, index: number, actions: Action[]) => {
    const group = (item: Action) => initial.rail.indexOf(item) < 0 ? 3
      : initial.rail.indexOf(item) < 3 ? 0 : initial.rail.indexOf(item) < 5 ? 1 : 2;
    return index > 0 && group(action) !== group(actions[index - 1]);
  };

  function tile(action: Action, index: number, zone: Zone) {
    const label = buttonLabel(action);
    const insert = insertion?.zone === zone && insertion.before === action;
    const target = (event: DragEvent): Drop => {
      const rect = event.currentTarget.getBoundingClientRect();
      return { zone, before: action, after: event.clientY > rect.top + rect.height / 2 };
    };
    return <div key={action} className={[
      "mirror-tile", zone === "rail" && divider(action, index, railItems) ? "mirror-divider" : "",
      insert ? insertion.after ? "insert-after" : "insert-before" : "",
    ].join(" ")} onDragOver={(event) => dragOver(event, target(event))} onDrop={(event) => drop(event, target(event))}>
      <button type="button" className="icon-button" draggable data-mirror-action={action} {...tip(label)}
        data-dragging={dragging === action || undefined}
        onClick={() => void act(action).catch(() => {})}
        onDragStart={(event) => {
          dragRef.current = action;
          setDragging(action);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", action);
        }} onDragEnd={dragEnd}>
        <Icon path={action === "pause" && paused ? "m8 5 12 7-12 7z" : icons[action]} />
      </button>
    </div>;
  }

  cliHandler.current = async ({ operation, args }) => {
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 140));
    const action = args[0] as Action;
    const knownAction = (value: string) => Object.prototype.hasOwnProperty.call(icons, value);
    switch (operation) {
      case "state": {
        const box = (selector: string) => {
          const r = document.querySelector(selector)?.getBoundingClientRect();
          return r ? [r.x, r.y, r.width, r.height] : null;
        };
        const appList = document.querySelector(".mirror-apps");
        const button = document.querySelector(".mirror-toolbar .icon-button");
        return { layout: readLayout(), fullscreen: await shell.isFullscreen(), more, outside,
          shell: box(".mirror-shell"), rail: box(".mirror-toolbar"), menu: box(".mirror-more"),
          pinned: await shell.isAlwaysOnTop(), sidebar: sidebarEnabled, appCount: apps.length,
          appScroll: appList ? { height: appList.clientHeight, content: appList.scrollHeight } : null,
          buttonBackground: button ? getComputedStyle(button).backgroundColor : null,
          backgroundInset: getComputedStyle(document.querySelector(".mirror-video")!).paddingLeft, fps,
          virtual: !!info?.[4], follow: !!info?.[5], ready,
          title: windowTitle,
          videoViewport: box(".mirror-video-viewport"),
          error };
      }
      case "border": {
        const width = Number(args[0]);
        if (args.length !== 1 || !/^\d+$/.test(args[0]) || width > 12) throw "invalidArguments";
        saveLayout({ ...readLayout(), frameBorder: width });
        return readLayout();
      }
      case "style": {
        const [color, opacity] = args;
        if (args.length !== 2 || !/^#[0-9a-f]{6}$/i.test(color) || !/^\d+$/.test(opacity) || Number(opacity) > 100) {
          throw "invalidArguments";
        }
        saveLayout({ ...readLayout(), buttonColor: color, buttonOpacity: Number(opacity) });
        return readLayout();
      }
      case "tip": {
        if (args.length !== 1 || !knownAction(action)) throw "invalidArguments";
        if (readLayout().more.includes(action) && !more) {
          await changeMore(true);
          await settle();
        }
        const button = document.querySelector(`[data-mirror-action="${action}"]`);
        if (!button) throw "mirrorActionFailed";
        button.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
        try {
          await settle();
          const tooltip = document.querySelector(".mirror-caption, .mirror-fullscreen-tips > span");
          const bounds = tooltip?.getBoundingClientRect();
          if (!tooltip || !bounds) throw "mirrorActionFailed";
          return { text: tooltip.textContent, bounds: [bounds.x, bounds.y, bounds.width, bounds.height] };
        } finally {
          button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }));
        }
      }
      case "pin": return { pinned: await togglePin() };
      case "sidebar": return { visible: await toggleSidebar() };
      case "apps": return apps.map(({ app, display }) => ({ ...app, display, hasIcon: !!appIcons[app.package] }));
      case "app": {
        const shortcut = apps.find(({ app }) => app.package === args[0]);
        if (args.length !== 1 || !shortcut) throw "invalidArguments";
        await launchShortcut(shortcut);
        return null;
      }
      case "action":
        if (args.length === 2 && args[0] === "picture-radius") {
          const radius = Number(args[1]);
          if (!/^\d+$/.test(args[1]) || radius > 24) throw "invalidArguments";
          saveLayout({ ...readLayout(), pictureRadius: radius });
          return readLayout();
        }
        if (args.length === 1 && args[0] === "top") return { pinned: await togglePin() };
        if (args.length !== 1 || !knownAction(action)) throw "invalidArguments";
        return { action, output: (await act(action)) ?? null };
      case "more":
        if (args.length !== 1 || !["open", "close"].includes(args[0])) throw "invalidArguments";
        const sizes: number[][] = [];
        const captureSize = () => {
          const rect = viewport.current?.getBoundingClientRect();
          if (rect) sizes.push([rect.width, rect.height]);
        };
        captureSize();
        const observer = new ResizeObserver(captureSize);
        if (viewport.current) observer.observe(viewport.current);
        try {
          await changeMore(args[0] === "open");
          await settle();
          captureSize();
          return { sizes };
        } finally { observer.disconnect(); }
      case "drag": {
        const [, zone, before] = args;
        if (!knownAction(action) || !["rail", "more"].includes(zone)
          || (before && !knownAction(before)) || args.length > 3) throw "invalidArguments";
        const current = readLayout();
        if (!sidebarEnabled || fullscreen) throw "mirrorActionFailed";
        if (current.more.includes(action) && !more) {
          await changeMore(true);
          await settle();
        }
        const source = document.querySelector(`[data-mirror-action="${action}"]`);
        if (!source) throw "mirrorActionFailed";
        const transfer = new DataTransfer();
        const drag = (target: Element, type: string) => target.dispatchEvent(new DragEvent(type, {
          bubbles: true, cancelable: true, dataTransfer: transfer,
          clientY: target.getBoundingClientRect().top + 1,
        }));
        drag(source, "dragstart");
        try {
          if (zone === "more" && !document.querySelector(".mirror-more")) {
            const button = document.querySelector(".mirror-toolbar > button");
            if (!button) throw "mirrorActionFailed";
            drag(button, "dragover");
            await new Promise<void>((resolve) => setTimeout(resolve, 550));
          }
          const container = document.querySelector(zone === "rail" ? ".mirror-list" : ".mirror-more");
          const target = before ? container?.querySelector(`[data-mirror-action="${before}"]`)?.parentElement : container;
          if (!target) throw "mirrorActionFailed";
          drag(target, "dragover");
          drag(target, "drop");
          return readLayout();
        } finally { drag(source, "dragend"); dragEnd(); }
      }
      case "exit-fullscreen": {
        const before = await shell.isFullscreen();
        if (before) await escape();
        return { wasFullscreen: before, fullscreen: await shell.isFullscreen() };
      }
      case "minimize": await shell.minimize(); return null;
      case "restore": await shell.unminimize(); return null;
      case "move":
      case "resize": {
        const [a, b] = args.map(Number);
        if (args.length !== 2 || !Number.isInteger(a) || !Number.isInteger(b) || Math.abs(a) > 16000 || Math.abs(b) > 16000
          || (operation === "resize" && (a < minimumWidth || b < 310))) throw "invalidArguments";
        if (operation === "move") await shell.setPosition(new PhysicalPosition(a, b));
        else await shell.setSize(new LogicalSize(a, b));
        await savePlacement();
        return null;
      }
      default: throw "invalidArguments";
    }
  };

  const toolbarVisible = sidebarEnabled && (!fullscreen || reveal);
  const allowed = (action: Action) => !info?.[4] || ![
    "screenshot", "copyScreenshot", "screenPower", "screenOff", "notifications", "quickSettings", "captureFolder",
  ].includes(action);
  const moreItems = layout.more.filter(allowed);
  const railItems = layout.rail.filter(allowed);
  const chrome = {
    "--mirror-panel-width": `${outside ? menuWidth : 0}px`,
    "--mirror-opacity": `${layout.opacity}%`,
    "--mirror-background-inset": `${layout.frameBorder}px`,
    "--mirror-picture-radius": `${layout.pictureRadius}px`,
    "--mirror-edge-inset": `${pictureStartInset}px`,
    "--mirror-rail-width": `${sidebarWidth}px`,
    "--mirror-button-color": layout.buttonColor,
    "--mirror-button-opacity": `${layout.buttonOpacity}%`,
  } as CSSProperties;
  const moreMenu = more && toolbarVisible && <div style={{
    "--mirror-opacity": `${layout.opacity}%`,
    "--mirror-background-inset": `${layout.frameBorder}px`,
    "--mirror-button-color": layout.buttonColor,
    "--mirror-button-opacity": `${layout.buttonOpacity}%`,
  } as CSSProperties} className={`mirror-more${outside ? " mirror-more-outside" : ""}`}
    onDragOver={(event) => dragOver(event, { zone: "more" })} onDrop={(event) => drop(event, { zone: "more" })}>
    {moreItems.map((action, index) => tile(action, index, "more"))}
    {!moreItems.length && <div className="mirror-empty-menu" {...tip(t("mirrorDropHere"))}><Icon path="M12 5v14m-7-7h14" /></div>}
  </div>;
  return <><div className={`mirror-shell${fullscreen ? " is-fullscreen" : ""}`} style={{ ...chrome, width: lockedWidth }}>
    {!fullscreen && <div className="mirror-titlebar" data-tauri-drag-region>
      <span className="mirror-device-title" data-tauri-drag-region>
        <span data-tauri-drag-region>{windowTitle ?? t("mirrorStarting")}</span>
        <span className="mirror-fps" data-tauri-drag-region>{fps ?? "—"}</span>
      </span>
      <span className="mirror-caption" data-tauri-drag-region>{caption}</span>
      <div className="mirror-caption-actions">
        <button type="button" className="icon-button" aria-expanded={sidebarEnabled}
          {...tip(t(sidebarEnabled ? "mirrorCollapseSidebar" : "mirrorExpandSidebar"))}
          onClick={() => void toggleSidebar().catch(() => setError("mirrorFrameFailed"))}>
          <Icon path={sidebarEnabled ? "M3 4h18v16H3zm12 0v16m-7-11 3 3-3 3" : "M3 4h18v16H3zm12 0v16m-4-11-3 3 3 3"} />
        </button>
        <button type="button" className="icon-button mirror-pin" aria-pressed={top}
          {...tip(t(top ? "mirrorUnpin" : "mirrorPin"))}
          onClick={() => void togglePin().catch(() => setError("mirrorActionFailed"))}>
          <Icon path={pinIcon} />
        </button>
        {([
          ["mirrorMinimize", "M5 12h14", () => shell.minimize()],
          ["mirrorMaximize", "M5 5h14v14H5z", async () => { if (menuPending.current) return; if (more) await changeMore(false); await shell.toggleMaximize(); }],
          ["mirrorClose", "m6 6 12 12M18 6 6 18", async () => { await savePlacement().catch(() => {}); await shell.close(); }],
        ] as const).map(([label, path, run]) => <button key={label} type="button" className="icon-button"
          {...tip(t(label))} onClick={() => void run().catch(() => setError("mirrorFrameFailed"))}>
          <Icon path={path} />
        </button>)}
      </div>
    </div>}
    {fullscreen && reveal && <div className="mirror-fullscreen-tips">
      {caption && <span>{caption}</span>}
    </div>}
    <div className="mirror-body">
      <div className="mirror-video" style={lockedPicture ? {
        flex: "none", width: lockedPicture[0] + picturePadding,
        height: lockedPicture[1] + picturePadding,
      } : undefined}>
        <div className="mirror-video-viewport" ref={viewport}>
        </div>
      </div>
      {toolbarVisible && <div className="mirror-side" onMouseLeave={() => {
        if (fullscreen && !dragging && !more) setReveal(false);
      }}>
        <aside className="mirror-toolbar">
          <div className={`mirror-list${insertion?.zone === "rail" && !insertion.before ? " insert-after" : ""}`}
            onDragOver={(event) => dragOver(event, { zone: "rail" })}
            onDrop={(event) => drop(event, { zone: "rail" })}>
            {railItems.map((action, index) => tile(action, index, "rail"))}
          </div>
          {apps.length > 0 && <div className="mirror-apps" role="group" aria-label={t("mirrorApps")}>
            {apps.map((shortcut) => {
              const { package: id, name } = shortcut.app;
              return <button key={id} type="button" className="icon-button mirror-app"
                {...tip(name || id)} aria-busy={launchingApp === id}
                onClick={() => void launchShortcut(shortcut).catch(() => {})}>
                {appIcons[id] ? <img src={appIcons[id]} alt="" draggable={false} /> : <Icon path={appIcon} />}
              </button>;
            })}
          </div>}
          <button type="button" className="icon-button" aria-expanded={more} {...tip(t("mirrorMore"))} onClick={() => void changeMore(!more).catch(() => setError("mirrorFrameFailed"))}
            onDragOver={(event) => {
              dragOver(event, { zone: "more" });
              if (dragRef.current && !more && !hoverTimer.current) hoverTimer.current = setTimeout(() => void changeMore(true).catch(() => setError("mirrorFrameFailed")), 250);
            }}
            onDragLeave={() => { clearTimeout(hoverTimer.current); hoverTimer.current = undefined; }}
            onDrop={(event) => drop(event, { zone: "more" })}>
            <Icon path="M5 12h.01m7 0h.01m7 0h.01" />
          </button>
        </aside>
        {!outside && moreMenu}
      </div>}
      {sidebarEnabled && fullscreen && !reveal && <div className="mirror-reveal" onPointerEnter={() => setReveal(true)} />}
    </div>
    {error && <div className="mirror-error" onClick={() => setError("")} role="alert">{t(error as Message)}</div>}
  </div>{outside && moreMenu}
  </>;
}
