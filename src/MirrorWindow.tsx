import { ArrowLeft, House, PanelsTopLeft, Volume2, Volume1, Camera, Maximize, Bell,
  LayoutGrid, LockKeyhole, Smartphone, RotateCw, Scan, MoveHorizontal, Pause, Play,
  RotateCcw, Copy, FolderUp, FolderOpen, ClipboardPaste, Pin, PanelRightClose,
  PanelRightOpen, Minus, Maximize2, X, Plus, Ellipsis } from "lucide-react";
import { flushSync } from "react-dom";
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, LogicalSize, PhysicalPosition, PhysicalSize, primaryMonitor } from "@tauri-apps/api/window";
import { getInitialLocale, locales, type Message } from "./locales";
import { loadMap, type Shortcut } from "./Workflows";
import { mirrorMinimumHeight as minimumHeight, mirrorMinimumWidth as minimumWidth } from "./mirrorSizing";
import "./MirrorWindow.css";

const icons = {
  back: ArrowLeft, home: House, recents: PanelsTopLeft, volumeUp: Volume2, volumeDown: Volume1,
  screenshot: Camera, fullscreen: Maximize, notifications: Bell, quickSettings: LayoutGrid,
  screenPower: LockKeyhole, screenOff: Smartphone, rotate: RotateCw, actual: Scan,
  fit: MoveHorizontal, pause: Pause, resetVideo: RotateCcw, copyScreenshot: Copy,
  sendFiles: FolderUp, captureFolder: FolderOpen, paste: ClipboardPaste,
};
type Action = keyof typeof icons;
type Zone = "rail" | "more";
type Layout = {
  opacity: number; visible: boolean; rail: Action[]; more: Action[];
  buttonColor: string; buttonOpacity: number; frameBorder: number; pictureRadius: number;
};
type MirrorInfo = [title: string, width: number, height: number, serial: string, virtual: boolean, follow: boolean,
  recording: boolean, hardware: string | null];

const initial: Layout = {
  opacity: 88, visible: true, buttonColor: "#2a2b36", buttonOpacity: 100, frameBorder: 3, pictureRadius: 5,
  rail: ["back", "home", "recents", "volumeUp", "volumeDown", "screenshot", "fullscreen"],
  more: ["notifications", "quickSettings", "screenPower", "screenOff", "rotate", "actual", "fit",
    "pause", "resetVideo", "copyScreenshot", "captureFolder", "sendFiles", "paste"],
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

function ButtonColorPicker({ color, update, t }: { color: string; update: (color: string) => void; t: (key: Message) => string }) {
  const [open, setOpen] = useState(false);
  const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
  const brightness = Math.max(red, green, blue);
  const spread = brightness - Math.min(red, green, blue);
  const rememberedSaturation = useRef(0);
  const saturation = brightness ? spread / brightness : rememberedSaturation.current;
  const hue = !spread ? 0 : (60 * (brightness === red ? (green - blue) / spread
    : brightness === green ? 2 + (blue - red) / spread : 4 + (red - green) / spread) + 360) % 360;
  const rememberedHue = useRef(hue);
  if (spread) rememberedHue.current = hue;
  const angle = rememberedHue.current * Math.PI / 180;

  function select(h: number, s: number, v: number) {
    rememberedHue.current = h;
    rememberedSaturation.current = s;
    const channel = (offset: number) => {
      const k = (offset + h / 60) % 6;
      return Math.round(v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))) * 255).toString(16).padStart(2, "0");
    };
    update(`#${channel(5)}${channel(3)}${channel(1)}`);
  }

  function point(event: PointerEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * 2 - 1;
    const y = (event.clientY - rect.top) / rect.height * 2 - 1;
    select((Math.atan2(y, x) * 180 / Math.PI + 360) % 360, Math.min(1, Math.hypot(x, y)), brightness || 1);
  }

  return <div className="settings-stack">
    <div className="settings-color-row">
      <span>{t("mirrorButtonColor")}</span>
      <button type="button" className="icon-button color-swatch" aria-expanded={open}
        aria-label={`${t("mirrorButtonColor")} · ${color}`}
        style={{ "--swatch": color } as CSSProperties} onClick={() => setOpen(!open)} />
    </div>
    {open && <div className="color-picker settings-stack">
      <button type="button" className="icon-button color-wheel" aria-label={t("colorWheel")}
        style={{ "--wheel-shade": 1 - brightness, "--color-x": `${50 + Math.cos(angle) * saturation * 50}%`,
          "--color-y": `${50 + Math.sin(angle) * saturation * 50}%`, "--swatch": color } as CSSProperties}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          point(event);
        }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) point(event); }}
        onKeyDown={(event) => {
          const delta = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -.05, ArrowUp: .05 }[event.key];
          if (delta === undefined) return;
          event.preventDefault();
          if (Math.abs(delta) > 1) select((rememberedHue.current + delta + 360) % 360, saturation || 1, brightness || 1);
          else select(rememberedHue.current, Math.max(0, Math.min(1, saturation + delta)), brightness || 1);
        }} />
      <label className="field"><span>{t("colorBrightness")} · {Math.round(brightness * 100)}%</span>
        <input type="range" min="0" max="100" value={Math.round(brightness * 100)}
          onChange={(event) => select(rememberedHue.current, saturation, Number(event.target.value) / 100)} />
      </label>
    </div>}
  </div>;
}

export function MirrorAppearance({ t }: { t: (key: Message) => string }) {
  const layout = useLayout();
  return <section className="panel controls settings-card">
    <h2>{t("mirrorAppearance")}</h2>
    <div className="settings-grid">
      <div className="settings-stack settings-subgroup">
        <h3>{t("pictureStyle")}</h3>
        <label className="field">
          <span>{t("windowOpacity")} · {layout.opacity}%</span>
          <input type="range" min="20" max="100" value={layout.opacity}
            onChange={(event) => saveLayout({ ...readLayout(), opacity: Number(event.target.value) })} />
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
      </div>
      <div className="settings-stack settings-subgroup">
        <h3>{t("buttonStyle")}</h3>
        <ButtonColorPicker color={layout.buttonColor} t={t}
          update={(buttonColor) => saveLayout({ ...readLayout(), buttonColor })} />
        <label className="field">
          <span>{t("mirrorButtonOpacity")} · {layout.buttonOpacity}%</span>
          <input type="range" min="0" max="100" value={layout.buttonOpacity}
            onChange={(event) => saveLayout({ ...readLayout(), buttonOpacity: Number(event.target.value) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={layout.visible}
            onChange={(event) => saveLayout({ ...readLayout(), visible: event.target.checked })} />
          {t("mirrorToolbarVisible")}
        </label>
        <div><button type="button" onClick={() => saveLayout({ ...readLayout(), rail: initial.rail, more: initial.more })}>
          {t("mirrorResetLayout")}
        </button></div>
      </div>
    </div>
  </section>;
}

type Drop = { zone: Zone; before?: Action; after?: boolean };

type ToolbarRequest = { id: number; operation: string; args: string[] };
type PixelLimit = { viewportWidth: number; viewportHeight: number; frameWidth: number; frameHeight: number };

function fitPicture(width: number, height: number, frameWidth: number, frameHeight: number, upscale: boolean) {
  // Match scrcpy's integer aspect fit to avoid exposing its clear color along an edge.
  return {
    width: Math.min(width, Math.floor(height * frameWidth / frameHeight), upscale ? Infinity : frameWidth),
    height: Math.min(height, Math.floor(width * frameHeight / frameWidth), upscale ? Infinity : frameHeight),
  };
}

const menuWidth = 64;
const sidebarWidth = 53;
const baseMinimumSize = new LogicalSize(minimumWidth, minimumHeight);
const expandedMinimumSize = new LogicalSize(minimumWidth + menuWidth, minimumHeight);

export default function MirrorWindow() {
  const [shell] = useState(getCurrentWindow);
  const [locale, setLocale] = useState(getInitialLocale);
  const [info, setInfo] = useState<MirrorInfo>();
  const [deviceTitle, setDeviceTitle] = useState<string>();
  const [fps, setFps] = useState<number | null>(null);
  const [frameSize, setFrameSize] = useState<[number, number]>();
  const textureSwap = useRef<boolean>(undefined);
  const [lockedWidth, setLockedWidth] = useState<number>();
  const [lockedPicture, setLockedPicture] = useState<[number, number]>();
  const changingSidebar = useRef(false);
  const [apps, setApps] = useState<Shortcut[]>([]);
  const [appIcons, setAppIcons] = useState<Record<string, string>>({});
  const [launchingApp, setLaunchingApp] = useState<string>();
  const iconRequests = useRef(new Set<string>());
  const [more, setMore] = useState(false);
  const moreOpen = useRef(false);
  const dismissMoreAfterInteraction = useRef(false);
  const dismissMoreOnRestore = useRef(false);
  const dismissMoreHandler = useRef<() => void>(() => {});
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
  const [sizingNotice, setSizingNotice] = useState<Message>();
  const sizingNoticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pixelLimit, setPixelLimit] = useState<PixelLimit>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const layout = useLayout();
  const pictureStartInset = fullscreen ? layout.frameBorder : Math.max(4, layout.frameBorder);
  const picturePadding = pictureStartInset + layout.frameBorder;
  const sidebarEnabled = sidebarOverride ?? layout.visible;
  const t = (key: Message) => locales[locale][key];
  const titleCaption = sizingNotice ? t(sizingNotice) : caption;

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
    const blur = listen(`mirror-blur-${shell.label}`, () => dismissMoreHandler.current());
    void shell.isFullscreen().then(setFullscreen);
    void shell.isAlwaysOnTop().then(setTop);
    invoke<MirrorInfo>("mirror_info").then(setInfo).catch(() => setError("mirrorFrameFailed"));
    return () => {
      window.removeEventListener("storage", syncLocale);
      clearTimeout(sizingNoticeTimer.current);
      void bridge.then((unlisten) => unlisten());
      void blur.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const serial = info?.[4] ? undefined : info?.[3];
  const hardware = info?.[7] ?? undefined;
  const deviceKey = hardware ? `hardware:${hardware}` : undefined;
  const windowTitle = deviceTitle ?? info?.[0];
  const [baseWidth, baseHeight] = (ready ? frameSize : undefined) ?? [info?.[1] ?? 1, info?.[2] ?? 1];
  const [sourceWidth, sourceHeight] = landscape ? [baseHeight, baseWidth] : [baseWidth, baseHeight];
  useEffect(() => {
    if (!serial || !deviceKey) return;
    const sync = () => {
      const name = loadMap<string>("device-aliases")[deviceKey]
        || (loadMap<string>("device-identities")[serial] === hardware
          ? loadMap<{ model: string }>("known-devices")[serial]?.model : undefined);
      setDeviceTitle(name);
    };
    sync();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [serial, hardware, deviceKey]);
  useEffect(() => {
    if (windowTitle) void shell.setTitle(windowTitle).catch(() => {});
  }, [shell, windowTitle]);
  useEffect(() => {
    if (!info) return;
    let active = true;
    const poll = () => {
      void invoke<[number | null, [number, number] | null]>("mirror_stats").then(([count, size]) => {
        if (!active) return;
        setFps(count);
        if (!size || info[5]) return;
        const [width, height] = size;
        // The initial window already reflects any launch-time display rotation.
        if (width !== height && info[1] !== info[2]) {
          textureSwap.current ??= (width > height) !== (info[1] > info[2]);
        }
        const next: [number, number] = textureSwap.current ? [height, width] : size;
        setFrameSize((current) => current?.[0] === next[0] && current[1] === next[1] ? current : next);
      }).catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [info]);
  useEffect(() => {
    if (!serial || !deviceKey) return;
    const sync = () => {
      setApps(loadMap<Shortcut[]>("phone-app-shortcuts")[deviceKey] ?? []);
      setAppIcons(loadMap<Record<string, string>>("phone-shortcut-icons")[deviceKey] ?? {});
    };
    sync();
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [serial, deviceKey]);

  useEffect(() => {
    if (!serial || !hardware || !deviceKey) return;
    for (const { app } of apps) {
      if (appIcons[app.package] || iconRequests.current.has(app.package)) continue;
      iconRequests.current.add(app.package);
      void invoke<string>("app_icon", { serial, hardware, package: app.package }).then((icon) => {
        const cache = loadMap<Record<string, string>>("phone-shortcut-icons");
        cache[deviceKey] = { ...cache[deviceKey], [app.package]: icon };
        setAppIcons(cache[deviceKey]);
        try { localStorage.setItem("phone-shortcut-icons", JSON.stringify(cache)); } catch { /* 图标仍在当前窗口显示。 */ }
      }).catch(() => {});
    }
  }, [serial, hardware, deviceKey, apps, appIcons]);

  async function launchShortcut(shortcut: Shortcut) {
    if (!info || !hardware || launchingApp) return;
    setError("");
    setLaunchingApp(shortcut.app.package);
    try {
      await invoke("open_app_window", {
        serial: info[3], hardware, package: shortcut.app.package,
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
        const left = pixels(rect.left), top = pixels(rect.top);
        const availableWidth = pixels(rect.right) - left;
        const availableHeight = pixels(rect.bottom) - top;
        const limitUpscaling = pixelLimit?.frameWidth === sourceWidth && pixelLimit.frameHeight === sourceHeight
          && Math.abs(availableWidth - pixelLimit.viewportWidth) <= 1
          && Math.abs(availableHeight - pixelLimit.viewportHeight) <= 1;
        const { width, height } = info[5]
          ? { width: availableWidth, height: availableHeight }
          : fitPicture(availableWidth, availableHeight, sourceWidth, sourceHeight, !limitUpscaling);
        const bounds = {
          x: left + Math.round((availableWidth - width) / 2),
          y: top + Math.round((availableHeight - height) / 2),
          width, height,
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
    // A cross-monitor DPI change can retain the logical viewport dimensions.
    // Recompute its physical bounds even when ResizeObserver has no size change.
    const scaleChange = shell.onScaleChanged(update);
    window.addEventListener("resize", update);
    update();
    return () => {
      stopped = true;
      observer.disconnect();
      void scaleChange.then((unlisten) => unlisten()).catch(() => {});
      window.removeEventListener("resize", update);
      cancelAnimationFrame(frame);
    };
  }, [info, sourceWidth, sourceHeight, layout.pictureRadius, pixelLimit]);

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
    if (info && !info[4]) queue();
    const resumeDismissal = () => {
      if (dismissMoreOnRestore.current) dismissMoreHandler.current();
    };
    const listeners = [shell.onMoved(queue), shell.onResized(() => {
      queue();
      resumeDismissal();
    }), shell.onFocusChanged(({ payload }) => {
      if (payload) resumeDismissal();
      if (payload && !inputReady.current) {
        void invoke<boolean>("mirror_prepare_input").then((focused) => { inputReady.current = focused; }).catch(() => {});
      }
    })];
    return () => {
      clearTimeout(saving.current);
      for (const listener of listeners) void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [ready, shell, info]);

  function dismissMore() {
    dismissMoreAfterInteraction.current = menuPending.current || (moreOpen.current && !!dragRef.current);
    if (moreOpen.current && !dismissMoreAfterInteraction.current) {
      void changeMore(false).catch(() => setError("mirrorFrameFailed"));
    }
  }
  dismissMoreHandler.current = dismissMore;

  async function changeMore(open: boolean) {
    if ((open && busy) || open === moreOpen.current || priming.current || menuPending.current) return;
    menuPending.current = true;
    const setOpen = (value: boolean) => {
      moreOpen.current = value;
      setMore(value);
    };
    const frame = document.querySelector(".mirror-shell");
    const widthBefore = frame?.getBoundingClientRect().width;
    const waitWidth = async (width: number) => {
      const deadline = performance.now() + 450;
      while (Math.abs(innerWidth - width) > 1 && performance.now() < deadline) {
        // A minimized window may stop producing animation frames.
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    };
    try {
      if (open && !fullscreen && !await shell.isMaximized()) {
        const [size, position, monitor, scale] = await Promise.all([
          shell.innerSize(), shell.outerPosition(), currentMonitor(), shell.scaleFactor(),
        ]);
        const width = Math.round(menuWidth * scale);
        const right = monitor ? monitor.workArea.position.x + monitor.workArea.size.width : position.x + size.width + width;
        const expandedLeft = Math.max(monitor?.workArea.position.x ?? position.x, Math.min(position.x, right - size.width - width));
        if (!monitor || size.width + width <= monitor.workArea.size.width) {
          flushSync(() => setLockedWidth(widthBefore));
          if (expandedLeft !== position.x) await shell.setPosition(new PhysicalPosition(expandedLeft, position.y));
          try {
            await shell.setSize(new PhysicalSize(size.width + width, size.height));
            await shell.setMinSize(expandedMinimumSize);
            await waitWidth((size.width + width) / scale);
          } catch (error) {
            await shell.setMinSize(baseMinimumSize).catch(() => {});
            await shell.setSize(size).catch(() => {});
            if (expandedLeft !== position.x) await shell.setPosition(position);
            throw error;
          }
          extension.current = { left: position.x, expandedLeft };
          flushSync(() => { setOutside(true); setOpen(true); });
          return;
        }
      } else if (!open && extension.current) {
        dismissMoreOnRestore.current = true;
        if (await shell.isMinimized()) return;
        dismissMoreOnRestore.current = false;
        const saved = extension.current;
        const [size, position, scale] = await Promise.all([shell.innerSize(), shell.outerPosition(), shell.scaleFactor()]);
        flushSync(() => setLockedWidth(widthBefore));
        const width = Math.max(Math.ceil(minimumWidth * scale), size.width - Math.round(menuWidth * scale));
        await shell.setMinSize(baseMinimumSize);
        try {
          await shell.setSize(new PhysicalSize(width, size.height));
        } catch (error) {
          await shell.setMinSize(expandedMinimumSize).catch(() => {});
          throw error;
        }
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
      if (dismissMoreAfterInteraction.current && !dismissMoreOnRestore.current) dismissMore();
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
      const ratio = sourceWidth / sourceHeight;
      const width = info[5] ? box.width : Math.min(box.width, box.height * ratio);
      const height = info[5] ? box.height : Math.min(box.height, box.width / ratio);
      const [scale, origin] = await Promise.all([shell.scaleFactor(), shell.outerPosition()]);
      const requestedWidth = Math.round((width + picturePadding + (next ? sidebarWidth : 0)) * scale);
      const requestedHeight = Math.round((height + (frame?.height ?? innerHeight) - box.height) * scale);
      const target = new PhysicalSize(Math.max(requestedWidth, Math.ceil(minimumWidth * scale)),
        Math.max(requestedHeight, Math.ceil(minimumHeight * scale)));
      const dx = Math.round((box.x + (box.width - width) / 2) * scale) - Math.round(pictureStartInset * scale)
        - (info[5] ? 0 : Math.round((target.width - requestedWidth) / 2));
      const dy = Math.round((box.y + (box.height - height) / 2) * scale) - Math.round(box.y * scale)
        - (info[5] ? 0 : Math.round((target.height - requestedHeight) / 2));
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

  function showSizingNotice(message?: Message) {
    clearTimeout(sizingNoticeTimer.current);
    setSizingNotice(message);
    if (message) sizingNoticeTimer.current = setTimeout(() => setSizingNotice(undefined), 4500);
  }

  async function showOriginalPixels() {
    if (!info || !viewport.current) return;
    if (moreOpen.current) await changeMore(false);
    if (info[5]) {
      // In follow mode the virtual display already matches the native viewport.
      showSizingNotice("mirrorActualFollow");
      return;
    }
    if (!frameSize) {
      showSizingNotice("mirrorActualWaiting");
      return;
    }
    const [frameWidth, frameHeight] = landscape ? [frameSize[1], frameSize[0]] : frameSize;
    if (await shell.isFullscreen()) {
      await shell.setFullscreen(false);
      flushSync(() => { setFullscreen(false); setReveal(false); });
    }
    if (await shell.isMaximized()) await shell.toggleMaximize();
    const [monitor, position, scale, inner, outer] = await Promise.all([
      currentMonitor(), shell.outerPosition(), shell.scaleFactor(), shell.innerSize(), shell.outerSize(),
    ]);
    const workArea = monitor?.workArea ?? (await primaryMonitor())?.workArea;
    const windowBounds = document.querySelector(".mirror-shell")?.getBoundingClientRect();
    const videoBounds = viewport.current?.getBoundingClientRect();
    if (!workArea || !windowBounds || !videoBounds) throw "mirrorFrameFailed";
    const pixels = (n: number) => Math.round(n * window.devicePixelRatio);
    const chromeWidth = pixels(videoBounds.left) - pixels(windowBounds.left)
      + pixels(windowBounds.right) - pixels(videoBounds.right);
    const chromeHeight = pixels(videoBounds.top) - pixels(windowBounds.top)
      + pixels(windowBounds.bottom) - pixels(videoBounds.bottom);
    const borderWidth = Math.max(0, outer.width - inner.width);
    const borderHeight = Math.max(0, outer.height - inner.height);
    const maxWidth = workArea.size.width - borderWidth;
    const maxHeight = workArea.size.height - borderHeight;
    const availableWidth = Math.max(1, maxWidth - chromeWidth);
    const availableHeight = Math.max(1, maxHeight - chromeHeight);
    const picture = fitPicture(availableWidth, availableHeight, frameWidth, frameHeight, false);
    const width = Math.min(maxWidth, Math.max(Math.ceil(minimumWidth * scale), picture.width + chromeWidth));
    const height = Math.min(maxHeight, Math.max(Math.ceil(minimumHeight * scale), picture.height + chromeHeight));
    setPixelLimit({ frameWidth, frameHeight, viewportWidth: width - chromeWidth, viewportHeight: height - chromeHeight });
    await shell.setSize(new PhysicalSize(width, height));
    const x = Math.max(workArea.position.x, Math.min(position.x, workArea.position.x + maxWidth - width));
    const y = Math.max(workArea.position.y, Math.min(position.y, workArea.position.y + maxHeight - height));
    if (x !== position.x || y !== position.y) await shell.setPosition(new PhysicalPosition(x, y));
    if (picture.width !== frameWidth || picture.height !== frameHeight) showSizingNotice("mirrorActualScaled");
  }

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
      } else if (action === "actual") {
        showSizingNotice();
        await showOriginalPixels();
      } else if (action === "fit") {
        showSizingNotice();
        setPixelLimit(undefined);
        if (!info || !viewport.current) return;
        if (more) await changeMore(false);
        const box = viewport.current.getBoundingClientRect();
        const ratio = sourceWidth / sourceHeight;
        const width = Math.min(box.width, box.height * ratio);
        const shellBox = document.querySelector(".mirror-shell")?.getBoundingClientRect();
        const scale = await shell.scaleFactor();
        await shell.setSize(new PhysicalSize(
          Math.max(Math.ceil(minimumWidth * scale), Math.round((width + (shellBox?.width ?? innerWidth) - box.width) * scale)),
          Math.max(Math.ceil(minimumHeight * scale), Math.round((width / ratio + (shellBox?.height ?? innerHeight) - box.height) * scale)),
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
    if (dismissMoreAfterInteraction.current) dismissMore();
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
    const Glyph = action === "pause" && paused ? Play : icons[action];
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
        <Glyph aria-hidden="true" />
      </button>
    </div>;
  }

  cliHandler.current = async ({ operation, args }) => {
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 140));
    const action = args[0] as Action;
    const knownAction = (value: string) => Object.prototype.hasOwnProperty.call(icons, value);
    switch (operation) {
      case "state": {
        const rect = (element: Element | null) => {
          const r = element?.getBoundingClientRect();
          return r ? [r.x, r.y, r.width, r.height] : null;
        };
        const box = (selector: string) => rect(document.querySelector(selector));
        const appList = document.querySelector(".mirror-apps");
        const button = document.querySelector(".mirror-list .icon-button") ?? document.querySelector(".mirror-toolbar > button");
        return { layout: readLayout(), fullscreen: await shell.isFullscreen(), more, outside,
          scaleFactor: await shell.scaleFactor(), pixelRatio: window.devicePixelRatio, monitor: await currentMonitor(),
          shell: box(".mirror-shell"), rail: box(".mirror-toolbar"), menu: box(".mirror-more"),
          pinned: await shell.isAlwaysOnTop(), sidebar: sidebarEnabled, appCount: apps.length,
          appScroll: appList ? { height: appList.clientHeight, content: appList.scrollHeight } : null,
          buttonBackground: button ? getComputedStyle(button).backgroundColor : null,
          backgroundInset: getComputedStyle(document.querySelector(".mirror-video")!).paddingLeft, fps,
          fpsDisplay: box(".mirror-toolbar .mirror-fps"), navigation: box(".mirror-toolbar .mirror-list"), railButton: rect(button),
          captionButtons: Array.from(document.querySelectorAll(".mirror-caption-actions .icon-button"), rect),
          virtual: !!info?.[4], follow: !!info?.[5], ready,
          title: windowTitle,
          caption: titleCaption,
          sourceSize: info ? [sourceWidth, sourceHeight] : null,
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
        const frameRate = args[0] === "fps";
        if (args.length !== 1 || (!frameRate && !knownAction(action))) throw "invalidArguments";
        if (readLayout().more.includes(action) && !more) {
          await changeMore(true);
          await settle();
        }
        const button = document.querySelector(frameRate ? ".mirror-fps" : `[data-mirror-action="${action}"]`);
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
          || (operation === "resize" && (a < 160 || b < minimumHeight))) throw "invalidArguments";
        if (operation === "move") await shell.setPosition(new PhysicalPosition(a, b));
        else await shell.setSize(new LogicalSize(Math.max(a, outside ? expandedMinimumSize.width : minimumWidth), b));
        await savePlacement();
        return null;
      }
      default: throw "invalidArguments";
    }
  };

  const toolbarVisible = sidebarEnabled && (!fullscreen || reveal);
  const allowed = (action: Action) => !info?.[4] || ![
    "screenshot", "copyScreenshot", "screenPower", "screenOff", "notifications", "quickSettings", "captureFolder", "sendFiles",
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
    {!moreItems.length && <div className="mirror-empty-menu" {...tip(t("mirrorDropHere"))}><Plus aria-hidden="true" /></div>}
  </div>;
  return <><div className={`mirror-shell${fullscreen ? " is-fullscreen" : ""}`} style={{ ...chrome, width: lockedWidth }}>
    {!fullscreen && <div className="mirror-titlebar" data-tauri-drag-region>
      <span className="mirror-device-title" data-tauri-drag-region>
        <span data-tauri-drag-region>{windowTitle ?? t("mirrorStarting")}</span>
        {info?.[6] && <span className="mirror-recording" data-tauri-drag-region>● {t("recordingActive")}</span>}
      </span>
      <span className="mirror-caption" title={sizingNotice ? titleCaption : undefined} data-tauri-drag-region>{titleCaption}</span>
      <div className="mirror-caption-actions">
        <button type="button" className="icon-button" aria-expanded={sidebarEnabled}
          {...tip(t(sidebarEnabled ? "mirrorCollapseSidebar" : "mirrorExpandSidebar"))}
          onClick={() => void toggleSidebar().catch(() => setError("mirrorFrameFailed"))}>
          {sidebarEnabled ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
        </button>
        <button type="button" className="icon-button mirror-pin" aria-pressed={top}
          {...tip(t(top ? "mirrorUnpin" : "mirrorPin"))}
          onClick={() => void togglePin().catch(() => setError("mirrorActionFailed"))}>
          <Pin aria-hidden="true" />
        </button>
        {([
          ["mirrorMinimize", Minus, async () => { if (more) await changeMore(false); await shell.minimize(); }],
          ["mirrorMaximize", Maximize2, async () => { if (menuPending.current) return; if (more) await changeMore(false); await shell.toggleMaximize(); }],
          ["mirrorClose", X, async () => { await savePlacement().catch(() => {}); await shell.close(); }],
        ] as const).map(([label, Glyph, run]) => <button key={label} type="button" className="icon-button"
          {...tip(t(label))} onClick={() => void run().catch(() => setError("mirrorFrameFailed"))}>
          <Glyph aria-hidden="true" />
        </button>)}
      </div>
    </div>}
    {fullscreen && reveal && <div className="mirror-fullscreen-tips">
      {titleCaption && <span>{titleCaption}</span>}
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
          <output className="icon-button mirror-fps" {...tip(t("frameRateReadout"))} aria-live="off">{fps ?? "—"}</output>
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
                {appIcons[id] ? <img src={appIcons[id]} alt="" draggable={false} /> : <LayoutGrid aria-hidden="true" />}
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
            <Ellipsis aria-hidden="true" />
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
