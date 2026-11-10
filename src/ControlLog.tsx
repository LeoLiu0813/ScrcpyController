import { Download, FolderOpen, Info, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ErrorToast from "./ErrorToast";
import type { Message } from "./locales";

type Entry = {
  ts_unix_ms?: number;
  elapsed_ms?: number;
  seq?: number;
  run_id?: string;
  session?: string | null;
  event?: string;
  detail?: Record<string, unknown>;
};
type Snapshot = {
  enabled: boolean;
  runId: string;
  entries: Entry[];
  dropped: number;
  storageMode: "memory";
  bufferBytes: number;
  overwritten: number;
  maxBytes: number;
  retainedFiles: number;
  error?: string | null;
};
type Translate = (key: Message) => string;

const eventLabels: Record<string, Message> = {
  "app.started": "controlLogAppStarted",
  "app.exiting": "controlLogAppExiting",
  "mirror.created": "controlLogMirrorCreated",
  "mirror.attached": "controlLogMirrorAttached",
  "mirror.closed": "controlLogMirrorClosed",
  "mirror.destroyed": "controlLogMirrorDestroyed",
  "mirror.close_requested": "controlLogMirrorCloseRequested",
  "mirror.attach_failed": "controlLogMirrorAttachFailed",
  "close_requested": "controlLogMirrorCloseRequested",
  "attach_failed": "controlLogMirrorAttachFailed",
  "mirror.foreground_changed": "controlLogForegroundChanged",
  "mirror.move_started": "controlLogMoveStarted",
  "mirror.move_ended": "controlLogMoveEnded",
  "mirror.resized": "controlLogResized",
  "input.sample_changed": "controlLogInputSample",
  "input.modifiers_synchronized": "controlLogModifiersSynchronized",
  "input.pointer_move": "controlLogPointerMove",
  "input.pointer_button": "controlLogPointerButton",
  "input.pointer_wheel": "controlLogPointerWheel",
  "input.hit_test": "controlLogHitTest",
  "geometry.video_bounds_changed": "controlLogVideoBounds",
  "geometry.refresh_requested": "controlLogVideoBounds",
  "input.trace_started": "controlLogMouseTraceStarted",
  "input.trace_stopped": "controlLogMouseTraceStopped",
  "input.trace_registered": "controlLogMouseTraceRegistered",
  "input.trace_failed": "controlLogMouseTraceFailed",
  "input.trace_dropped": "controlLogMouseTraceDropped",
  "geometry.hit_grid": "controlLogHitGrid",
  "focus.restore_started": "controlLogFocusStarted",
  "focus.restore_completed": "controlLogFocusCompleted",
  "focus.restore_skipped": "controlLogFocusSkipped",
  "focus.restore_result": "controlLogFocusResult",
  "focus.thread_attach": "controlLogThreadAttach",
  "focus.thread_detach": "controlLogThreadDetach",
  "shortcut.started": "controlLogShortcutStarted",
  "shortcut.queued": "controlLogShortcutQueued",
  "shortcut.completed": "controlLogShortcutCompleted",
  "shortcut.input_before": "controlLogShortcutInputBefore",
  "shortcut.input_after": "controlLogShortcutInputAfter",
  "action.started": "controlLogActionStarted",
  "action.completed": "controlLogActionCompleted",
  "cli.key_started": "controlLogKeyStarted",
  "cli.key_completed": "controlLogKeyCompleted",
  "cli.input_before": "controlLogCliInputBefore",
  "cli.input_after": "controlLogCliInputAfter",
  "ui.action": "controlLogUiAction",
  "ui.more_changed": "controlLogMoreChanged",
  "ui.sidebar_changed": "controlLogSidebarChanged",
  "ui.fullscreen_changed": "controlLogFullscreenChanged",
  "ui.toolbar_drag": "controlLogToolbarDrag",
};

function eventLabel(entry: Entry, t: Translate) {
  const mapped = entry.event ? eventLabels[entry.event] : undefined;
  return t(mapped ?? "controlLogOtherEvent");
}

function entryFailed(entry: Entry) {
  return entry.event === "mirror.attach_failed" || entry.detail?.success === false || entry.detail?.queued === false
    || (typeof entry.detail?.error_code === "string" && !!entry.detail.error_code);
}

function inputTip(entry: Entry, t: Translate) {
  const mask = entry.detail?.system_modifiers;
  const buttons = entry.detail?.buttons;
  if (typeof mask !== "number" || typeof buttons !== "number") return undefined;
  const modifiers: Message[] = ["controlLogLeftControl", "controlLogRightControl", "controlLogLeftShift", "controlLogRightShift",
    "controlLogLeftAlt", "controlLogRightAlt", "controlLogLeftSystem", "controlLogRightSystem"];
  const mouse: Message[] = ["controlLogLeftButton", "controlLogRightButton", "controlLogMiddleButton"];
  const pressed = (values: Message[], value: number) => values.filter((_, bit) => value & (1 << bit)).map(t).join(" / ") || t("controlLogAllReleased");
  return `${t("controlLogSystemKeys")} ${pressed(modifiers, mask)}; ${t("controlLogMouseButtons")} ${pressed(mouse, buttons)}`;
}

function pointerDetails(entry: Entry, t: Translate) {
  const detail = entry.detail;
  if (!detail) return "";
  const lines: string[] = [];
  const pair = (xKey: string, yKey: string, label: Message, percent = false) => {
    const x = detail[xKey], y = detail[yKey];
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const display = (value: number) => percent ? `${(value * 100).toFixed(2)}%` : String(Math.round(value * 100) / 100);
    lines.push(`${t(label)} ${display(x)}, ${display(y)}`);
  };
  pair("screen_x", "screen_y", "controlLogScreenCoordinates");
  pair("client_x", "client_y", "controlLogClientCoordinates");
  pair("video_x", "video_y", "controlLogVideoCoordinates");
  pair("normalized_x", "normalized_y", "controlLogRelativeCoordinates", true);
  pair("expected_frame_x", "expected_frame_y", "controlLogEstimatedFrameCoordinates");
  const buttons: Record<string, Message> = {
    left: "controlLogLeftButton", right: "controlLogRightButton", middle: "controlLogMiddleButton",
    x1: "controlLogSideButton1", x2: "controlLogSideButton2",
  };
  if (typeof detail.button === "string" && buttons[detail.button] && typeof detail.pressed === "boolean") {
    lines.push(`${t(buttons[detail.button])} · ${t(detail.pressed ? "controlLogPressed" : "controlLogReleased")}`);
  }
  if (typeof detail.wheel_delta === "number" && Number.isFinite(detail.wheel_delta)) {
    lines.push(`${t(detail.horizontal ? "controlLogHorizontalWheel" : "controlLogVerticalWheel")} ${detail.wheel_delta}`);
  }
  return lines.length ? `${lines.join("\n")}\n\n` : "";
}

function eventAction(entry: Entry, t: Translate) {
  const action = entry.detail?.action;
  if (typeof action !== "string") return undefined;
  const actions: Record<string, Message> = {
    back: "mirror_back", home: "mirror_home", recents: "mirror_recents",
    volumeUp: "mirror_volumeUp", volumeDown: "mirror_volumeDown",
    screenPower: "mirror_screenPower", screenOff: "mirror_screenOff", screenOn: "mirrorScreenOn",
    notifications: "mirror_notifications", quickSettings: "mirror_quickSettings",
    rotate: "mirror_rotate", paste: "mirror_paste", pause: "mirror_pause", resume: "mirrorResume",
    resetVideo: "mirror_resetVideo", screenshot: "mirror_screenshot", copyScreenshot: "mirror_copyScreenshot",
    captureFolder: "mirror_captureFolder", sendFiles: "mirror_sendFiles", fullscreen: "mirror_fullscreen",
    fit: "mirror_fit", actual: "mirror_actual",
  };
  return actions[action] ? t(actions[action]) : undefined;
}

function timeLabel(timestamp: number | undefined) {
  if (typeof timestamp !== "number") return "—";
  const value = new Date(timestamp);
  return Number.isNaN(value.getTime()) ? "—"
    : `${value.toLocaleTimeString([], { hour12: false })}.${String(value.getMilliseconds()).padStart(3, "0")}`;
}

function timeAttribute(timestamp: number | undefined) {
  if (typeof timestamp !== "number") return undefined;
  const value = new Date(timestamp);
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
}

export default function ControlLog({ t }: { t: Translate }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [exportedPath, setExportedPath] = useState<string>();

  useEffect(() => {
    let disposed = false;
    setBusy(true);
    void invoke<Snapshot>("control_log_read", { limit: 300 }).then((value) => {
      if (!disposed) setSnapshot(value);
    }).catch(() => {
      if (!disposed) setFailed(true);
    }).finally(() => {
      if (!disposed) setBusy(false);
    });
    return () => { disposed = true; };
  }, []);

  async function run(operation: "refresh" | "toggle" | "export" | "reveal", enabled?: boolean) {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      if (operation === "export") {
        setExportedPath(await invoke<string>("control_log_export"));
      } else if (operation === "reveal") {
        if (exportedPath) await invoke("reveal_capture", { path: exportedPath });
      } else {
        setSnapshot(await invoke<Snapshot>(operation === "toggle" ? "control_log_set_enabled" : "control_log_read",
          operation === "toggle" ? { enabled: !!enabled } : { limit: 300 }));
      }
    } catch { setFailed(true); }
    finally { setBusy(false); }
  }

  const entries = snapshot?.entries ?? [];
  const retention = snapshot ? t("controlLogRetention")
    .replace("{size}", String(Math.round(snapshot.maxBytes / 1024 / 1024))) : t("controlLogPrivacy");
  const capacity = snapshot ? t("controlLogCapacity")
    .replace("{used}", (snapshot.bufferBytes / 1024 / 1024).toFixed(2))
    .replace("{max}", String(Math.round(snapshot.maxBytes / 1024 / 1024))) : undefined;

  return <section className="panel controls settings-card control-log" aria-busy={busy}>
    <div className="settings-card-heading">
      <h2>{t("controlLogs")}</h2>
      <span className="control-log-info" tabIndex={0} data-tip={`${t("controlLogPrivacy")} ${retention}`}>
        <Info size={17} aria-hidden="true" /><span className="sr-only">{t("controlLogPrivacy")}</span>
      </span>
    </div>
    <div className="control-log-controls">
      <label className="check" data-tip={t("controlLogPrivacy")}>
        <input type="checkbox" checked={snapshot?.enabled ?? false} disabled={!snapshot || busy}
          onChange={(event) => void run("toggle", event.target.checked)} />
        {t("controlLogEnabled")}
      </label>
      <div className="actions">
        <button type="button" className="icon-button" aria-label={t("controlLogRefresh")} data-tip={t("controlLogRefresh")}
          disabled={busy} onClick={() => void run("refresh")}><RefreshCw aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label={t("controlLogExport")} data-tip={t("controlLogExportHint")}
          disabled={!snapshot || busy} onClick={() => void run("export")}><Download aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label={t("controlLogReveal")} data-tip={t("controlLogReveal")}
          disabled={!exportedPath || busy} onClick={() => void run("reveal")}><FolderOpen aria-hidden="true" /></button>
      </div>
    </div>
    <div className="control-log-filter">
      <span className="status" aria-live="polite">{t("controlLogRecentCount").replace("{count}", String(entries.length))}</span>
      {snapshot && <>
        <span data-tip={retention}>{capacity}</span>
        <span data-tip={t("controlLogOverwriteHint")}>{t("controlLogOverwritten").replace("{count}", String(snapshot.overwritten))}</span>
      </>}
    </div>
    <div className="control-log-list" role="region" aria-label={t("controlLogEntries")} tabIndex={0}>
      {!entries.length && <p className="empty">{t(busy ? "working" : "controlLogEmpty")}</p>}
      {[...entries].reverse().map((entry, index) => <details className={`control-log-entry${entryFailed(entry) ? " control-log-failure" : ""}`}
        key={`${entry.run_id ?? "run"}:${entry.seq ?? index}`}>
        <summary data-tip={inputTip(entry, t)}>
          <time dateTime={timeAttribute(entry.ts_unix_ms)}>
            {timeLabel(entry.ts_unix_ms)}
          </time>
          <span className="control-log-event">{eventLabel(entry, t)}
            {eventAction(entry, t) && <small>{eventAction(entry, t)}</small>}
          </span>
          {entry.session && <span className="control-log-session" data-tip={t("controlLogAnonymousSession")}>
            {t("controlLogSession").replace("{number}", entry.session.replace(/^window-/, ""))}
          </span>}
        </summary>
        <pre aria-label={t("controlLogDetails")}>{pointerDetails(entry, t)}{JSON.stringify(entry, null, 2)}</pre>
      </details>)}
    </div>
    {(!!snapshot?.dropped || exportedPath) && <div className="control-log-result" role="status">
      {!!snapshot?.dropped && <span>{t("controlLogDropped").replace("{count}", String(snapshot.dropped))}</span>}
      {exportedPath && <span>{t("controlLogExported")}</span>}
    </div>}
    <ErrorToast message={failed || snapshot?.error ? t("controlLogFailed") : undefined} dismiss={t("dismissNotice")} />
  </section>;
}
