export const locales = {
  "zh-CN": {
    title: "安卓控制台",
    language: "界面语言",
    heading: "设备管理",
    description: "项目骨架已就绪。设备连接与投屏将在后续阶段接入。",
  },
  "en-US": {
    title: "Android Control Center",
    language: "Display language",
    heading: "Devices",
    description: "The app is ready for device connection and mirroring integration.",
  },
};

export type Locale = keyof typeof locales;

export function getInitialLocale(): Locale {
  const saved = localStorage.getItem("display-language");
  if (saved === "zh-CN" || saved === "en-US") return saved;
  return navigator.language.toLowerCase().startsWith("en") ? "en-US" : "zh-CN";
}
