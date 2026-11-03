import { useEffect, useState } from "react";
import { getInitialLocale, locales, type Locale } from "./locales";
import "./App.css";

export default function App() {
  const [locale, setLocale] = useState(getInitialLocale);
  const messages = locales[locale];

  useEffect(() => {
    localStorage.setItem("display-language", locale);
    document.documentElement.lang = locale;
    document.title = messages.title;
  }, [locale, messages.title]);

  return (
    <main>
      <header>
        <h1>{messages.title}</h1>
        <label>
          {messages.language}
          <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
            <option value="zh-CN" lang="zh-CN">简体中文</option>
            <option value="en-US" lang="en-US">English</option>
          </select>
        </label>
      </header>
      <section>
        <h2>{messages.heading}</h2>
        <p>{messages.description}</p>
      </section>
    </main>
  );
}
