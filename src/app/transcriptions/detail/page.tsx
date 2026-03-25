// app/transcriptions/detail/page.tsx
"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import TranscriptionDetailPageClient from "@/components/TranscriptionDetailPageClient"; // adjust path if needed
import { useTranslations } from "next-intl";


// Inner component that uses useSearchParams()
function DetailContent() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  if (!id) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 text-center">
        <p className="text-lg text-red-500 dark:text-red-400">
          {t("No transcription ID provided")}
          <br />
          {t("Please go back and select a transcription from the list")}
        </p>
      </div>
    );
  }

  return <TranscriptionDetailPageClient params={{ id }} />;
}

// Main page component with Suspense
export default function TranscriptionDetailPage() {
const t = useTranslations();
   
  
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-pink-500"></div>
          <p className="ml-4 text-zinc-400">{t("Loading transcription")}</p>
        </div>
      }
    >
      <DetailContent />
    </Suspense>
  );
}