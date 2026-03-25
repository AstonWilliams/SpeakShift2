// app/not-found.tsx
"use client";

import { usePathname } from "next/navigation";
import TranscriptionDetailPageClient from "../components/TranscriptionDetailPageClient";
import { useTranslations } from "next-intl";

export default function NotFound() {
  const t = useTranslations();
  const pathname = usePathname();

  if (pathname?.startsWith("/transcriptions/")) {
    const id = pathname.split("/").filter(Boolean)[1];

    if (id) {
      return <TranscriptionDetailPageClient params={{ id }} />;
    }
  }

  // Fallback 404 UI
  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 text-white p-6">
      <div className="text-center space-y-6">
        <h1 className="text-8xl font-bold">404</h1>
        <p className="text-2xl">{t("Page not found")}</p>
        <a href="/" className="px-8 py-4 bg-pink-600 hover:bg-pink-500 rounded-xl text-lg font-bold">
          {t("Go Home")}
        </a>
      </div>
    </div>
  );
}