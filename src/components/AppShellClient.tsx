"use client";

import { ThemeProvider } from "@/components/ThemeProvider";
import { Sidebar } from "@/components/Sidebar";
import ErrorReporter from "@/components/ErrorReporter";
import IntlProvider from "@/lib/IntlProvider";
import { useTranscriptionCompletedListener } from "@/lib/hooks/useTranscriptionListener";
import VisualEditsMessenger from "@/visual-edits/VisualEditsMessenger";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type OfflineLicenseStatus = {
  isPro: boolean;
  plan: string;
  buyerName?: string | null;
  buyerEmail?: string | null;
  licenseId?: string | null;
  activatedAt?: number | null;
  message: string;
};

export default function AppShellClient({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  useTranscriptionCompletedListener();

  const pathname = usePathname();
  const [isPro, setIsPro] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadLicense = async () => {
      try {
        const status = await invoke<OfflineLicenseStatus>("get_offline_license_status");
        if (!cancelled) {
          setIsPro(status.isPro);
        }
      } catch {
        if (!cancelled) {
          setIsPro(false);
        }
      }
    };

    void loadLicense();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const isFreeAllowedRoute = useMemo(() => {
    const allowed = [
      /^\/$/,
      /^\/settings(?:\/.*)?$/,
      /^\/convert(?:\/.*)?$/,
      /^\/transcribe(?:\/.*)?$/,
      /^\/transcriptions(?:\/.*)?$/,
      /^\/profile(?:\/.*)?$/,
    ];
    return allowed.some((re) => re.test(pathname));
  }, [pathname]);

  const shouldShowProLock = !isPro && !isFreeAllowedRoute;

  const openBuyLink = async () => {
    const url = "https://usefulthings.gumroad.com/l/bzris";
    try {
      await open(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
    >
      <IntlProvider initialLocale="en">
        <ErrorReporter />

        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 lg:ml-64 relative">
            {children}

            {shouldShowProLock && (
              <div className="absolute inset-0 z-70 bg-zinc-950/60 backdrop-blur-sm flex items-center justify-center p-6">
                <div className="w-full max-w-xl rounded-3xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 shadow-2xl">
                  <h2 className="text-2xl sm:text-3xl font-black mb-3">Pro Feature Locked</h2>
                  <p className="text-zinc-600 dark:text-zinc-300 mb-6 leading-relaxed">
                    This page is available in Pro. Free users can use Home, Settings, Transcription, and Video Editing. Upgrade now to unlock all features.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <button
                      onClick={openBuyLink}
                      className="inline-flex items-center justify-center rounded-xl bg-pink-600 hover:bg-pink-700 text-white px-5 py-3 text-sm font-semibold"
                    >
                      Buy Pro
                    </button>
                    <Link
                      href="/profile"
                      className="inline-flex items-center justify-center rounded-xl border border-zinc-300 dark:border-zinc-700 px-5 py-3 text-sm font-semibold"
                    >
                      Activate Existing Key
                    </Link>
                  </div>
                </div>
              </div>
            )}
          </main>
        </div>

        <VisualEditsMessenger />
      </IntlProvider>
    </ThemeProvider>
  );
}
