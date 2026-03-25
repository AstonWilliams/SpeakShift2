"use client";

import { NextIntlClientProvider } from "next-intl";
import { createContext, useContext, useState, useEffect, ReactNode, Suspense } from "react";

type Locale = "en";

interface IntlContextType {
  locale: Locale;
  setLocale: (newLocale: Locale) => Promise<void>;
}

const IntlContext = createContext<IntlContextType | undefined>(undefined);

export function useAppLocale() {
  const ctx = useContext(IntlContext);
  if (!ctx) throw new Error("useAppLocale must be used inside IntlProvider");
  return ctx;
}

export default function IntlProvider({
  children,
  initialLocale = "en",
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [messages, setMessages] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      let lang = initialLocale;

      if (typeof window !== "undefined") {
        const saved = localStorage.getItem("app-language") as Locale | null;
        if (saved && ["en"].includes(saved)) lang = saved;
      }

      try {
        const mod = await import(`../messages/${lang}.json`);
        setMessages(mod.default);
        setLocaleState(lang);
      } catch (err) {
        console.error("Failed to load messages:", err);
        const fallback = await import(`../messages/en.json`);
        setMessages(fallback.default);
        setLocaleState("en");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [initialLocale]);

  const setLocale = async (newLocale: Locale) => {
    if (newLocale === locale) return;

    setLoading(true);
    try {
      const mod = await import(`../messages/${newLocale}.json`);
      setMessages(mod.default);
      setLocaleState(newLocale);
      localStorage.setItem("app-language", newLocale);
    } catch (err) {
      console.error("Locale switch failed:", err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center">Loading language...</div>;
  }

  return (
    <IntlContext.Provider value={{ locale, setLocale }}>
      <NextIntlClientProvider 
        locale={locale} 
        messages={messages}
        timeZone="Asia/Karachi"
      >
        <Suspense fallback={<div>Loading translations...</div>}>
          {children}
        </Suspense>
      </NextIntlClientProvider>
    </IntlContext.Provider>
  );
}