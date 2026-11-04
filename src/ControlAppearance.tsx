import { useLayoutEffect, useState } from "react";
import { ChevronRight, RotateCcw } from "lucide-react";
import type { Locale, Message } from "./locales";
import "./appearance.css";

const storageKey = "control-appearance-v2";
const legacyKey = "control-appearance-v1";
const appearanceEvent = "control-appearance-change";
type Value = string | number;
type Values = Record<string, Value>;
type Label = readonly [string, string];
type Color = { kind: "color"; property: string; label: Label; initial: string; legacy?: string };
type Range = { kind: "range"; property: string; label: Label; initial: number; min: number; max: number; step: number; legacy?: string };
type Field = Color | Range;

const background = ["底色", "Background"] as const;
const foreground = ["文字颜色", "Text color"] as const;
const border = ["边框颜色", "Border color"] as const;
const radius = ["圆角", "Corner radius"] as const;
const height = ["高度", "Height"] as const;
const hover = ["悬停底色", "Hover background"] as const;
const size = ["大小", "Size"] as const;

function color(property: string, label: Label, initial: string, legacy?: string): Color {
  return { kind: "color", property, label, initial, legacy };
}

function range(property: string, label: Label, initial: number, min: number, max: number, legacy?: string, step = 1): Range {
  return { kind: "range", property, label, initial, min, max, step, legacy };
}

const groups: { id: string; title: Label; fields: Field[] }[] = [
  { id: "window", title: ["窗口与文字", "Window and text"], fields: [
    color("theme-background", background, "#17171f", "background"),
    color("theme-text", foreground, "#ececf2", "text"),
    color("theme-muted", ["次要文字", "Secondary text"], "#a5a6ba", "muted"),
    color("theme-accent", ["强调色", "Accent color"], "#bb9af7", "accent"),
    color("main-focus-color", ["焦点轮廓", "Focus outline"], "#bb9af7", "accent"),
    range("main-text-size", ["字号", "Text size"], 14, 12, 18, "textSize"),
    range("field-gap", ["控件间距", "Control spacing"], 12, 8, 20, "gap"),
  ] },
  { id: "panel", title: ["内容面板", "Content panels"], fields: [
    color("theme-panel", background, "#20212b", "panel"),
    color("theme-border", border, "#363743", "border"),
    color("main-pane-border", ["主面板边框", "Main panel border"], "#575869"),
    range("panel-radius", radius, 8, 0, 20, "panelRadius"),
    range("section-padding", ["内边距", "Padding"], 16, 8, 28),
  ] },
  { id: "titlebar", title: ["主窗口标题栏", "Main window title bar"], fields: [
    color("main-caption-color", foreground, "#ececf2", "text"),
    color("main-caption-hover", hover, "#4a435e"),
    color("main-caption-close", ["关闭按钮悬停底色", "Close button hover background"], "#a43e4d"),
    range("main-caption-size", ["窗口按钮大小", "Window button size"], 27, 22, 36),
    range("main-caption-icon", ["图标大小", "Icon size"], 16, 13, 22),
  ] },
  { id: "nav", title: ["导航按钮", "Navigation buttons"], fields: [
    color("main-nav-color", ["图标颜色", "Icon color"], "#ececf2", "text"),
    color("main-nav-background", background, "#2a2b36", "controls"),
    color("main-nav-hover", hover, "#4a435e"),
    color("main-nav-selected", ["选中底色", "Selected background"], "#4a435e"),
    color("main-nav-selected-color", ["选中图标颜色", "Selected icon color"], "#e5d6ff"),
    range("main-nav-radius", radius, 6, 0, 14, "radius"),
  ] },
  { id: "button", title: ["文字按钮", "Text buttons"], fields: [
    color("main-button-background", background, "#2a2b36", "controls"),
    color("main-button-hover", hover, "#4a435e"),
    color("main-button-color", foreground, "#ececf2", "text"),
    color("main-button-border", border, "#363743", "border"),
    color("main-button-primary", ["主要按钮底色", "Primary button background"], "#50486a"),
    color("main-button-primary-hover", ["主要按钮悬停底色", "Primary button hover background"], "#615581"),
    color("main-button-primary-color", ["主要按钮文字", "Primary button text"], "#f1e7ff"),
    color("main-button-primary-border", ["主要按钮边框", "Primary button border"], "#7f6a9e"),
    range("main-button-height", height, 36, 28, 46, "height"),
    range("main-button-radius", radius, 6, 0, 16, "radius"),
  ] },
  { id: "icon", title: ["图标按钮", "Icon buttons"], fields: [
    color("main-icon-background", background, "#2a2b36", "controls"),
    color("main-icon-hover", hover, "#4a435e"),
    color("main-icon-active", ["按下或选中底色", "Pressed or selected background"], "#4a435e"),
    color("main-icon-color", ["图标颜色", "Icon color"], "#ececf2", "text"),
    color("main-icon-border", border, "#363743", "border"),
    range("main-icon-height", ["按钮大小", "Button size"], 36, 30, 40, "height"),
    range("main-icon-radius", radius, 6, 0, 14, "radius"),
    range("main-icon-size", ["图标大小", "Icon size"], 19, 15, 23, "iconSize"),
    range("main-icon-stroke", ["图标线宽", "Icon stroke width"], 1.65, 1.25, 2.5, "stroke", .05),
  ] },
  { id: "input", title: ["输入框与文本区", "Inputs and text areas"], fields: [
    color("main-input-background", background, "#2a2b36", "controls"),
    color("main-input-color", foreground, "#ececf2", "text"),
    color("main-input-placeholder", ["占位文字", "Placeholder text"], "#a5a6ba", "muted"),
    color("main-input-border", border, "#363743", "border"),
    color("main-input-focus", ["焦点边框", "Focus border"], "#bb9af7", "accent"),
    range("main-input-height", height, 36, 28, 46, "height"),
    range("main-input-radius", radius, 6, 0, 16, "radius"),
  ] },
  { id: "select", title: ["下拉框与选项列表", "Dropdowns and option lists"], fields: [
    color("main-select-background", background, "#2a2b36", "controls"),
    color("main-select-color", foreground, "#ececf2", "text"),
    color("main-select-border", border, "#363743", "border"),
    color("main-list-background", ["选项列表底色", "Option list background"], "#262731"),
    color("main-list-hover", ["高亮选项底色", "Highlighted option background"], "#4a435e"),
    range("main-select-height", height, 36, 28, 46, "height"),
    range("main-select-radius", radius, 6, 0, 16, "radius"),
  ] },
  { id: "slider", title: ["滑块", "Sliders"], fields: [
    color("main-slider-track", ["轨道颜色", "Track color"], "#363743"),
    color("main-slider-thumb", ["滑块颜色", "Thumb color"], "#bb9af7", "accent"),
    color("main-slider-thumb-border", ["滑块边框", "Thumb border"], "#e5d6ff"),
    range("main-slider-track-height", ["轨道粗细", "Track thickness"], 5, 2, 10),
    range("main-slider-thumb-size", ["滑块大小", "Thumb size"], 15, 10, 24),
  ] },
  { id: "check", title: ["复选框", "Checkboxes"], fields: [
    color("main-check-background", background, "#2a2b36", "controls"),
    color("main-check-border", border, "#575869"),
    color("main-check-active", ["选中底色", "Checked background"], "#bb9af7", "accent"),
    color("main-check-mark", ["勾选颜色", "Check mark color"], "#21182d"),
    range("main-check-size", size, 16, 12, 22),
    range("main-check-radius", radius, 4, 0, 8),
  ] },
  { id: "dialog", title: ["弹窗与遮罩", "Dialogs and backdrop"], fields: [
    color("main-dialog-background", background, "#20212b", "panel"),
    color("main-dialog-border", border, "#363743", "border"),
    color("main-dialog-overlay", ["遮罩颜色", "Backdrop color"], "#101015"),
    range("main-dialog-opacity", ["遮罩不透明度", "Backdrop opacity"], 66, 0, 90),
    range("main-dialog-radius", radius, 8, 0, 20, "panelRadius"),
  ] },
  { id: "tooltip", title: ["悬停提示", "Tooltips"], fields: [
    color("main-tooltip-background", background, "#30313e"),
    color("main-tooltip-color", foreground, "#ececf2", "text"),
    color("main-tooltip-border", border, "#575869"),
    range("main-tooltip-radius", radius, 5, 0, 14),
    range("main-tooltip-size", ["字号", "Text size"], 13, 11, 18),
  ] },
  { id: "toast", title: ["错误通知", "Error notifications"], fields: [
    color("main-toast-background", background, "#31242d"),
    color("main-toast-color", foreground, "#f3dce2"),
    color("main-toast-border", border, "#714853"),
    range("main-toast-radius", radius, 8, 0, 20),
  ] },
];

const fields = groups.flatMap((group) => group.fields);

function stored(key: string): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") ?? {};
  } catch { return {}; }
}

function validValue(field: Field, value: unknown): value is Value {
  return field.kind === "color" ? typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    : typeof value === "number" && value >= field.min && value <= field.max;
}

function readAppearance(): Values {
  const legacy = localStorage.getItem(storageKey) === null;
  const raw = stored(legacy ? legacyKey : storageKey);
  const result: Values = {};
  for (const field of fields) {
    const value = raw[legacy ? field.legacy ?? "" : field.property];
    if (validValue(field, value)) result[field.property] = value;
  }
  return result;
}

function applyAppearance() {
  const root = document.documentElement.style;
  const saved = readAppearance();
  for (const field of fields) {
    const value = saved[field.property] ?? field.initial;
    const unit = field.kind === "color" || field.property === "main-icon-stroke" ? ""
      : field.property === "main-dialog-opacity" ? "%" : "px";
    root.setProperty("--" + field.property, value + unit);
  }
  const legacy = stored(legacyKey);
  const mirrorValues = [
    ["--control-height", "height", 30, 40, "px"], ["--control-radius", "radius", 0, 14, "px"],
    ["--theme-icon-size", "iconSize", 15, 22, "px"], ["--theme-stroke", "stroke", 1.25, 2.5, ""],
  ] as const;
  for (const [property, key, min, max, unit] of mirrorValues) {
    const value = legacy[key];
    if (typeof value === "number" && value >= min && value <= max) root.setProperty(property, value + unit);
  }
}

export function AppearanceRuntime() {
  useLayoutEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key === storageKey || event.key === legacyKey || event.key === null) applyAppearance();
    }
    applyAppearance();
    window.addEventListener("storage", sync);
    window.addEventListener(appearanceEvent, applyAppearance);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(appearanceEvent, applyAppearance);
    };
  }, []);
  return null;
}

export default function ControlAppearance({ t, locale }: { t: (key: Message) => string; locale: Locale }) {
  const [values, setValues] = useState(readAppearance);
  const localize = (label: Label) => label[locale === "en-US" ? 1 : 0];
  function save(next: Values) {
    localStorage.setItem(storageKey, JSON.stringify(next));
    setValues(next);
    window.dispatchEvent(new Event(appearanceEvent));
  }
  function resetGroup(group: typeof groups[number]) {
    const next = { ...values };
    for (const field of group.fields) delete next[field.property];
    save(next);
  }

  return <section className="panel controls settings-card control-appearance">
    <div className="settings-card-heading">
      <h2>{t("controlAppearance")}</h2>
      <button type="button" className="icon-button" aria-label={t("resetAppearance")} data-tip={t("resetAppearance")}
        onClick={() => save({})}><RotateCcw aria-hidden="true" /></button>
    </div>
    {groups.map((group) => <details key={group.id} name="control-appearance-group" className="appearance-group">
      <summary><ChevronRight aria-hidden="true" />{localize(group.title)}</summary>
      <div className="appearance-group-fields">
        {group.fields.map((field) => {
          const value = values[field.property] ?? field.initial;
          const label = localize(field.label);
          return field.kind === "color"
            ? <label key={field.property} className="settings-color-row theme-color">
              <span>{label}</span>
              <input type="color" value={String(value)}
                onChange={(event) => save({ ...values, [field.property]: event.target.value })} />
            </label>
            : <label key={field.property} className="field appearance-range">
              <span>{label}<span className="appearance-value">{value}{field.property === "main-dialog-opacity" ? "%" : ""}</span></span>
              <input type="range" min={field.min} max={field.max} step={field.step} value={value}
                onChange={(event) => save({ ...values, [field.property]: Number(event.target.value) })} />
            </label>;
        })}
      </div>
      <div className="appearance-group-actions">
        <button type="button" className="icon-button" aria-label={t("resetAppearance")} data-tip={t("resetAppearance")}
          onClick={() => resetGroup(group)}><RotateCcw aria-hidden="true" /></button>
      </div>
    </details>)}
  </section>;
}
