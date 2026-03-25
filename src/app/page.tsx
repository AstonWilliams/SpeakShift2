"use client";

import OnboardingCard from "@/components/OnboardingCard";
import { motion } from "framer-motion";
import {
  Upload,
  Scissors,
  FileAudio,
  ArrowRight,
  Shield,
  Zap,
  Star,
  CheckCircle2
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";

export default function Home() {
  const t = useTranslations();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;



  return (
    <div className="min-h-screen relative overflow-hidden flex flex-col items-center justify-center p-6 text-center">

      {/* Tutorial card – only shows once */}
      <OnboardingCard
        id="home-privacy-first22"
        title="Privacy First"
        description="Zero uploads. Everything stays on your machine — 100% local processing with no data ever leaving your device."
        imageSrc="/images/privacy-shield.png" // add a shield/privacy icon or screenshot
        buttonText="Got it!"
      />

      <OnboardingCard
        id="home-lightning-speed22"
        title="Lightning Speed"
        description="High-performance local engines deliver fast results — no waiting for cloud queues or slow internet."
        imageSrc="/images/speed-gauge.png" // speedometer, rocket, or performance graph
        buttonText="Next"
      />

      <OnboardingCard
        id="home-local-ai22"
        title="Local AI Power"
        description="Powered by Whisper and other open-source AI models running directly on your hardware — full control, no subscriptions."
        imageSrc="/images/local-ai-brain.png" // brain icon, Whisper logo, or local processing illustration
        buttonText="Next"
      />

      {/* Background Orbs */ }
      <div className="absolute top-[-15%] right-[-10%] w-[50%] h-[50%] bg-pink-100/40 dark:bg-pink-900/10 rounded-full blur-[140px]" />
      <div className="absolute bottom-[-10%] left-[-15%] w-[40%] h-[40%] bg-blue-100/40 dark:bg-blue-900/10 rounded-full blur-[140px]" />

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-4xl relative z-10"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2 }}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 shadow-xl mb-12 text-xs font-black uppercase tracking-widest text-[#FF4181]"
        >
          <Star className="w-3 h-3 fill-current" />
          {t("future-message-1")}
        </motion.div>

        <h1 className="text-7xl lg:text-9xl font-black leading-[0.95] tracking-tighter mb-10">
          {t("hook1")}<br />
          <span className="text-zinc-400 dark:text-zinc-600">{t("hook2")}</span>
        </h1>

        <p className="text-xl lg:text-2xl text-zinc-500 dark:text-zinc-400 font-medium mb-16 max-w-2xl mx-auto leading-relaxed">
          {t("hook3")}
        </p>

        <div className="flex flex-col sm:flex-row gap-6 justify-center mb-24">
          <Link href="/convert">
            <button className="w-full sm:w-auto bg-[#1A1A1A] dark:bg-white text-white dark:text-black px-12 py-7 rounded-[32px] text-2xl font-black flex items-center justify-center gap-4 hover:scale-105 active:scale-95 transition-all shadow-2xl shadow-black/20">
              {t("Go to Converter")}
              <ArrowRight className="w-6 h-6" />
            </button>
          </Link>
          <Link href="/transcribe">
            <button className="w-full sm:w-auto bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 px-12 py-7 rounded-[32px] text-2xl font-black hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-all shadow-xl">
              {t("Try Transcriber")}
            </button>
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-left">
          {[
            { title: t("Privacy First"), desc: t("Privacy First desc"), icon: Shield, color: "text-pink-500" },
            { title: t("LIGHTNING Speed"), desc: t("LIGHTNING Speed desc"), icon: Zap, color: "text-blue-500" },
            { title: t("Local AI"), desc: t("Local AI desc"), icon: CheckCircle2, color: "text-green-500" },
          ].map((card, i) => (
            <div key={i} className="p-8 rounded-[40px] bg-white/50 dark:bg-zinc-900/50 backdrop-blur-sm border border-white dark:border-zinc-800 shadow-sm hover:shadow-xl transition-all group">
              <div className="w-14 h-14 bg-white dark:bg-zinc-800 rounded-[20px] flex items-center justify-center mb-6 shadow-sm border border-zinc-50 dark:border-zinc-700 group-hover:bg-[#1A1A1A] dark:group-hover:bg-white transition-colors">
                <card.icon className={`w-6 h-6 ${card.color} group-hover:text-white dark:group-hover:text-black`} />
              </div>
              <h3 className="text-2xl font-bold mb-4">{card.title}</h3>
              <p className="text-zinc-500 dark:text-zinc-400 font-medium leading-relaxed">{card.desc}</p>
            </div>
          ))}
        </div>
      </motion.div>
      <br /><br />
      <footer className="absolute bottom-10 left-0 right-0 opacity-20">
        <div className="text-[10px] font-black uppercase tracking-[0.4em]">
          {t("footer-message-2")}
        </div>
      </footer>
    </div >
  );
}
