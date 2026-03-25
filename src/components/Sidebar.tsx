"use client";

import { motion } from "framer-motion";
import {
  Scissors,
  FileAudio,
  Boxes,
  Users,
  Settings,
  Home,
  ChevronRight,
  Zap,
  Library,
  UserCircle,
  Languages,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const menuItems = [
  { icon: Home, label: "Home", href: "/" },
  { icon: Scissors, label: "Convert", href: "/convert" },
  { icon: FileAudio, label: "Transcribe", href: "/transcribe" },
  { icon: Boxes, label: "Batch", href: "/batch" },
  { icon: Users, label: "Diarization", href: "/diarization" },
  { icon: Library, label: "Transcriptions", href: "/transcriptions" },
  { icon: Languages , label : "Translations", href: "/translations" },
  { icon: Settings, label: "Settings", href: "/settings" },
  { icon: UserCircle, label: "Profile", href: "/profile", special: true },
];

export function Sidebar() {
  const t = useTranslations();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <motion.div
      initial={{ x: -100, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      className="fixed left-0 top-0 h-screen w-20 lg:w-64 bg-white dark:bg-zinc-950 border-r border-zinc-200 dark:border-zinc-800 z-50 flex flex-col items-center lg:items-stretch py-8"
    >
      <div className="px-6 mb-12 flex items-center gap-3">
        <div className="w-10 h-10 bg-black dark:bg-white rounded-2xl flex items-center justify-center">
          <Zap className="text-white dark:text-black w-6 h-6" />
        </div>
        <span className="hidden lg:block font-black text-2xl tracking-tight">SpeakShift</span>
      </div>

      <nav className="flex-1 px-4 space-y-2 w-full">
        {menuItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link key={item.href} href={item.href}>
              <div className={`
                  flex items-center gap-4 px-4 py-4 rounded-2xl transition-all group relative
                  ${isActive
                  ? "bg-zinc-100 dark:bg-zinc-900 text-black dark:text-white"
                  : "text-zinc-400 hover:text-black dark:hover:text-white hover:bg-zinc-50 dark:hover:bg-zinc-900/50"}
                `}>
                <item.icon className={`${item.special ? "w-8 h-8" : "w-6 h-6"} ${isActive ? "text-pink-500" : ""}`} />
                <span className={`hidden lg:block font-bold ${item.special ? "text-lg" : ""}`}>{item.label}</span>
                {isActive && (
                  <motion.div
                    layoutId="sidebar-active"
                    className="absolute left-0 w-1 h-8 bg-pink-500 rounded-r-full"
                  />
                )}
                <ChevronRight className={`ml-auto w-4 h-4 hidden lg:block opacity-0 group-hover:opacity-100 transition-opacity ${isActive ? "text-zinc-300" : ""}`} />
              </div>
            </Link>
          );
        })}
      </nav>

      <div className="px-6 mt-auto">
        <div className="hidden lg:block p-6 rounded-3xl bg-pink-50 dark:bg-pink-950/20 border border-pink-100 dark:border-pink-900/30">
          <p className="text-xs font-black text-pink-600 dark:text-pink-400 uppercase tracking-widest mb-2">Pro Status</p>
          <p className="text-sm font-bold text-zinc-600 dark:text-zinc-300 leading-relaxed">
            {t("footer-message")}
          </p>
        </div>
      </div>
    </motion.div>
  );
}