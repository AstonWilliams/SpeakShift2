"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import TranslationsDetailClient from "@/components/TranslationsDetailClient";
import { useTranslations } from "next-intl";
import { AlertTriangle, Link, Loader2 } from "lucide-react";

function DetailContent() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  if (!id) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div className="max-w-md">
          <AlertTriangle className="w-16 h-16 mx-auto mb-6 text-red-500" />
          <h2 className="text-2xl font-bold mb-4">{t("No translation ID provided")}</h2>
          <p className="text-zinc-500 dark:text-zinc-400 mb-8">
            {t("Please select a translation from the list")}
          </p>
          <Link href="/translations">
            <button className="px-8 py-4 bg-pink-600 hover:bg-pink-500 text-white rounded-xl font-bold">
              {t("Back to Translations")}
            </button>
          </Link>
        </div>
      </div>
    );
  }

  return <TranslationsDetailClient id={id} />;
}

export default function TranslationsDetailPage() {
  const t = useTranslations();

  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="w-12 h-12 animate-spin text-pink-500 mr-4" />
          <p className="text-zinc-400">{t("Loading translation")}...</p>
        </div>
      }
    >
      <DetailContent />
    </Suspense>
  );
}