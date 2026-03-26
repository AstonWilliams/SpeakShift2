"use client";

import { motion } from "framer-motion";
import {
  Mail,
  MapPin,
  ShieldCheck,
  Globe,
  ExternalLink,
  Heart,
  Code2,
  BadgeCheck,
  Calendar,
  Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from '@tauri-apps/plugin-shell';

type OfflineLicenseStatus = {
  isPro: boolean;
  plan: string;
  buyerName?: string | null;
  buyerEmail?: string | null;
  licenseId?: string | null;
  activatedAt?: number | null;
  message: string;
};

type EntitlementStatus = {
  isPro: boolean;
  plan: string;
  lockedFeatures: string[];
  message: string;
};

export default function ProfilePage() {
  const [mounted, setMounted] = useState(false);
  const [heartScale, setHeartScale] = useState(1);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [licenseStatus, setLicenseStatus] = useState<OfflineLicenseStatus>({
    isPro: false,
    plan: "free",
    message: "No offline license activated",
  });
  const [activationName, setActivationName] = useState("");
  const [activationEmail, setActivationEmail] = useState("");
  const [activationKey, setActivationKey] = useState("");
  const [activationBusy, setActivationBusy] = useState(false);
  const [activationMessage, setActivationMessage] = useState("");
  const [entitlement, setEntitlement] = useState<EntitlementStatus>({
    isPro: false,
    plan: "free",
    lockedFeatures: ["Batch transcription", "Diarization", "Translation"],
    message: "Free tier active",
  });
  const t = useTranslations();
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "v1.0.0";

  useEffect(() => {
    const init = async () => {
      setMounted(true);
      try {
        const status = await invoke<OfflineLicenseStatus>("get_offline_license_status");
        setLicenseStatus(status);
      } catch {
        // Ignore in browser/non-Tauri contexts.
      }
      try {
        const ent = await invoke<EntitlementStatus>("get_entitlement_status");
        setEntitlement(ent);
      } catch {
        // Ignore in browser/non-Tauri contexts.
      }
    };
    void init();
  }, []);

  if (!mounted) return null;

  const userData = {
    fullName: licenseStatus.buyerName || "Free User",
    username: licenseStatus.isPro ? "PRO" : "FREE",
    email: licenseStatus.buyerEmail || "No email linked (Free tier)",
    address: "Local Device",
    version: licenseStatus.isPro ? "Pro" : "Free",
    country: "Not Set",
    purchaseDate: licenseStatus.activatedAt
      ? new Date(licenseStatus.activatedAt * 1000).toLocaleDateString()
      : "Not purchased yet",
  };

  const memberLabel = licenseStatus.isPro ? "Pro Member" : "Free User";

  const developerData = {
    email: "karlkuberx@gmail.com",
    website: "https://maxin-labs-krho.vercel.app/",
  };

  // Get initials from fullName or username
  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((part) => part[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const initials = getInitials(userData.fullName || userData.username);

  const handleHeartMouseEnter = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMousePos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    setHeartScale(1.1);
  };

  const handleHeartMouseMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMousePos({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  };

  const handleHeartMouseLeave = () => {
    setHeartScale(1);
  };

  const openExternal = async (url: string) => {
    try {
      await open(url);
      console.log(`Opened: ${url}`);
    } catch (err) {
      console.error("Failed to open:", err);
      alert(`Please open manually:\n${url}`);
    }
  };

  const activateOffline = async () => {
    setActivationMessage("");
    setActivationBusy(true);
    try {
      const status = await invoke<OfflineLicenseStatus>("activate_offline_license", {
        licenseKey: activationKey,
        name: activationName,
        email: activationEmail,
      });
      setLicenseStatus(status);
      try {
        const ent = await invoke<EntitlementStatus>("get_entitlement_status");
        setEntitlement(ent);
      } catch {
        // Ignore in browser/non-Tauri contexts.
      }
      setActivationMessage(status.message || "Offline activation successful");
      setActivationKey("");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Offline activation failed";
      setActivationMessage(msg);
    } finally {
      setActivationBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white">
      {/* Header */}
      <motion.header
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="px-6 sm:px-8 md:px-12 lg:px-16 py-12 sm:py-16 border-b border-zinc-200 dark:border-zinc-800"
      >
        <div className="max-w-6xl mx-auto">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-3">{t("Profile")}</h1>
          <p className="text-lg text-zinc-600 dark:text-zinc-400 font-light">
            {t("Your local identity and account status")}
          </p>
        </div>
      </motion.header>

      <main className="px-6 sm:px-8 md:px-12 lg:px-16 py-12 sm:py-16">
        <div className="max-w-6xl mx-auto space-y-8 sm:space-y-12">

          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="flex justify-center"
          >
            <div className="inline-flex flex-col items-center gap-3 px-8 py-6 rounded-2xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 shadow-sm">
              <img
                src="/images/app-icon.png"
                alt="SpeakShift icon"
                className="w-14 h-14 object-contain"
              />
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">Application Version</p>
              <p className="text-2xl sm:text-3xl font-bold text-zinc-900 dark:text-white">{appVersion}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {licenseStatus.isPro
                  ? `Licensed to ${licenseStatus.buyerName || "Pro User"}`
                  : "Free tier (Batch, Diarization, Translation are Pro)"}
              </p>
            </div>
          </motion.section>

          {!licenseStatus.isPro && (
            <motion.section
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 }}
              className="p-6 sm:p-8 rounded-2xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800"
            >
              <h3 className="text-xl font-bold mb-2">Offline Pro Activation</h3>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
                You are on the Free tier. Enter your name, email, and signed offline license key to permanently unlock Pro on this machine.
              </p>
              {entitlement.lockedFeatures.length > 0 && (
                <div className="mb-5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-4 py-3">
                  <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">
                    Locked on Free tier
                  </p>
                  <p className="text-sm text-zinc-700 dark:text-zinc-300">
                    {entitlement.lockedFeatures.join(", ")}
                  </p>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <input
                  value={activationName}
                  onChange={(e) => setActivationName(e.target.value)}
                  placeholder="Buyer name"
                  className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-pink-500"
                />
                <input
                  value={activationEmail}
                  onChange={(e) => setActivationEmail(e.target.value)}
                  placeholder="Buyer email"
                  className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-pink-500"
                />
              </div>
              <textarea
                value={activationKey}
                onChange={(e) => setActivationKey(e.target.value)}
                placeholder="Paste offline license key"
                rows={4}
                className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-pink-500"
              />
              <div className="mt-4 flex flex-col sm:flex-row sm:items-center gap-3">
                <button
                  onClick={activateOffline}
                  disabled={activationBusy}
                  className="inline-flex items-center justify-center rounded-xl bg-pink-600 hover:bg-pink-700 disabled:opacity-60 text-white px-5 py-3 text-sm font-semibold"
                >
                  {activationBusy ? "Activating..." : "Activate Pro Offline"}
                </button>
                <button
                  onClick={() => openExternal("https://usefulthings.gumroad.com/l/bzris")}
                  className="inline-flex items-center justify-center rounded-xl border border-pink-600 text-pink-700 dark:text-pink-300 hover:bg-pink-50 dark:hover:bg-pink-950/20 px-5 py-3 text-sm font-semibold"
                >
                  Buy Here
                </button>
                {activationMessage && (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">{activationMessage}</p>
                )}
              </div>
            </motion.section>
          )}

          {/* User Profile Card - Large with Initials Avatar */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="p-8 sm:p-12 rounded-3xl bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors"
          >
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6 sm:gap-10 mb-10 pb-10 border-b border-zinc-200 dark:border-zinc-800">
              {/* Big circular avatar with initials */}
              <div className="w-28 h-28 sm:w-32 sm:h-32 bg-linear-to-br from-pink-500 to-rose-600 rounded-full flex items-center justify-center shrink-0 shadow-lg">
                <span className="text-4xl sm:text-5xl font-bold text-white tracking-tight">
                  {initials}
                </span>
              </div>

              <div className="flex-1">
                <p className="text-xs font-semibold text-pink-600 dark:text-pink-400 uppercase tracking-widest mb-2">
                  {t("Account_Holder")}
                </p>
                <h2 className="text-4xl sm:text-5xl font-bold mb-2">{userData.fullName}</h2>
                <p className="text-base text-zinc-600 dark:text-zinc-400">
                  @{userData.username} • {memberLabel}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8 sm:gap-10">
              <div>
                <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest mb-2">
                  {t("Email Address")}
                </p>
                <div className="flex items-center gap-3">
                  <Mail className="w-5 h-5 text-zinc-400 shrink-0" />
                  <span className="text-lg">{userData.email}</span>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest mb-2">
                  {t("Location")}
                </p>
                <div className="flex items-center gap-3">
                  <MapPin className="w-5 h-5 text-zinc-400 shrink-0" />
                  <span className="text-lg">{userData.address}</span>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest mb-2">
                  {t("Country")}
                </p>
                <div className="flex items-center gap-3">
                  <Globe className="w-5 h-5 text-zinc-400 shrink-0" />
                  <span className="text-lg">{userData.country}</span>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest mb-2">
                  {t("Purchase Date")}
                </p>
                <div className="flex items-center gap-3">
                  <Calendar className="w-5 h-5 text-zinc-400 shrink-0" />
                  <span className="text-lg">{userData.purchaseDate}</span>
                </div>
              </div>
            </div>
          </motion.div>

          {/* License Tiers - Only Free & Pro */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="grid grid-cols-1 sm:grid-cols-2 gap-6 sm:gap-8"
          >
            {/* FREE TIER */}
            <div className="p-8 rounded-3xl bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 transition-all">
              <div className="flex items-center gap-2 mb-6">
                <BadgeCheck className="w-5 h-5 text-zinc-500" />
                <h3 className="text-xl font-bold">{t("Free")}</h3>
              </div>
              <p className="text-4xl font-bold mb-2">$0</p>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">{t("Forever free")}</p>
              <ul className="space-y-3 text-sm text-zinc-700 dark:text-zinc-300">
                <li className="flex items-center gap-2">✓ {t("Basic conversion")}</li>
                <li className="flex items-center gap-2">✓ {t("Up to 5 files/day")}</li>
                <li className="flex items-center gap-2">✓ {t("Standard support")}</li>
              </ul>
            </div>

            {/* PRO TIER - Active */}
            <motion.div
              whileHover={{ y: -4 }}
              className="p-8 rounded-3xl bg-linear-to-br from-pink-50 to-pink-100/50 dark:from-pink-950/20 dark:to-pink-900/10 border-2 border-pink-500 dark:border-pink-500 relative"
            >
              <div className="absolute -top-3 left-6 bg-pink-500 text-white px-3 py-1 rounded-full text-xs font-bold">
                {t("ACTIVE")}
              </div>
              <div className="flex items-center gap-2 mb-6">
                <Zap className="w-5 h-5 text-pink-600 dark:text-pink-400" />
                <h3 className="text-xl font-bold text-pink-600 dark:text-pink-400">{t("Pro")}</h3>
              </div>
              <p className="text-4xl font-bold mb-2 text-pink-600 dark:text-pink-400">
                {userData.version}
              </p>
              <p className="text-sm text-pink-700 dark:text-pink-300 mb-6">{t("One-time purchase")}</p>
              <ul className="space-y-3 text-sm text-zinc-700 dark:text-zinc-300 mb-6">
                <li className="flex items-center gap-2">✓ {t("Unlimited conversion")}</li>
                <li className="flex items-center gap-2">✓ {t("Advanced features")}</li>
                <li className="flex items-center gap-2">✓ {t("Priority support")}</li>
              </ul>
              <div className="inline-block px-4 py-2 bg-pink-600 text-white rounded-lg text-sm font-semibold">
                ✓ {t("License Active")}
              </div>
            </motion.div>
          </motion.div>

          {/* License Terms Section */}
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="p-8 sm:p-12 rounded-3xl bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800"
          >
            <div className="flex items-center gap-3 mb-8">
              <ShieldCheck className="w-6 h-6 text-zinc-700 dark:text-zinc-300" />
              <h2 className="text-2xl sm:text-3xl font-bold">{t("License Terms & Conditions")}</h2>
            </div>

            <div className="space-y-6">
              <div className="space-y-4 text-zinc-700 dark:text-zinc-300 text-sm leading-relaxed">
                <p>
                  <span className="font-semibold text-zinc-900 dark:text-white">Free Plan:</span>{" "}
                  Home, Settings, Transcription, Video Editing, and Transcription history are available at no cost.
                </p>
                <p>
                  <span className="font-semibold text-zinc-900 dark:text-white">Pro Plan:</span>{" "}
                  Unlocks premium features including advanced model management and all locked pages with a one-time offline activation key.
                </p>
                <p>
                  <span className="font-semibold text-zinc-900 dark:text-white">Offline Activation:</span>{" "}
                  Licenses are verified locally on your machine. Internet is not required for activation.
                </p>
                <p>
                  <span className="font-semibold text-rose-600 dark:text-rose-400">No Reselling or Redistribution:</span>{" "}
                  License keys and app binaries may not be resold, shared publicly, or redistributed.
                </p>
                <p>
                  <span className="font-semibold text-zinc-900 dark:text-white">Key Ownership:</span>{" "}
                  The private signing key remains with the seller only. Buyers receive signed license tokens, never private keys.
                </p>
              </div>
            </div>
          </motion.section>

          {/* Developer Section */}
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="p-8 sm:p-12 rounded-3xl bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800"
          >
            <div className="flex items-center gap-3 mb-8">
              <Code2 className="w-6 h-6 text-zinc-700 dark:text-zinc-300" />
              <h2 className="text-2xl sm:text-3xl font-bold">{t("Developer & Support")}</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
              <div className="space-y-4">
                <div>
                  <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-widest mb-2">
                    {t("Support Email")}
                  </p>
                  <button
                    onClick={() => openExternal(`mailto:${developerData.email}`)}
                    className="flex items-center gap-3 text-lg hover:text-pink-600 dark:hover:text-pink-400 transition-colors bg-transparent border-0 p-0 cursor-pointer"
                  >
                    <Mail className="w-5 h-5 text-zinc-400" />
                    {developerData.email}
                  </button>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <p className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-widest mb-2">
                    {t("Official Website")}
                  </p>
                  <button
                    onClick={() => openExternal(developerData.website)}
                    className="flex items-center gap-3 text-lg hover:text-pink-600 dark:hover:text-pink-400 transition-colors bg-none border-0 p-0 cursor-pointer"
                  >
                    <ExternalLink className="w-5 h-5 text-zinc-400" />
                    {developerData.website}
                  </button>
                </div>
              </div>
            </div>
          </motion.section>

          {/* Donation Section */}
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="p-8 sm:p-12 rounded-3xl bg-linear-to-br from-rose-50 to-pink-50 dark:from-rose-950/20 dark:to-pink-950/20 border border-rose-200 dark:border-rose-900/30"
          >
            <div className="text-center space-y-8">
              <div className="flex justify-center">
                <motion.div
                  onMouseEnter={handleHeartMouseEnter}
                  onMouseMove={handleHeartMouseMove}
                  onMouseLeave={handleHeartMouseLeave}
                  animate={{ scale: heartScale }}
                  transition={{ type: "spring", stiffness: 400, damping: 10 }}
                  className="relative cursor-pointer"
                >
                  <motion.div
                    animate={{
                      y: [0, -8, 0],
                    }}
                    transition={{
                      duration: 1.5,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                  >
                    <Heart className="w-20 h-20 sm:w-24 sm:h-24 text-rose-500 fill-rose-500 drop-shadow-lg" />
                  </motion.div>

                  <motion.div
                    animate={{
                      opacity: heartScale > 1 ? 0.3 : 0,
                      scale: heartScale > 1 ? 1.4 : 1,
                    }}
                    transition={{ duration: 0.3 }}
                    className="absolute inset-0 bg-rose-500 rounded-full blur-2xl -z-10"
                  />
                </motion.div>
              </div>

              <div>
                <h2 className="text-3xl sm:text-4xl font-bold mb-3 text-rose-900 dark:text-rose-100">
                  {t("Support Local Software")}
                </h2>
                <p className="text-lg text-rose-700 dark:text-rose-200 max-w-xl mx-auto leading-relaxed">
                  {t("donation-message")}
                </p>
              </div>

              <motion.button
                onClick={() =>
                  openExternal(
                    "https://patreon.com/MaxinLabs?utm_medium=unknown&utm_source=join_link&utm_campaign=creatorshare_creator&utm_content=copyLink"
                  )
                }
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="inline-block px-8 sm:px-12 py-4 sm:py-5 bg-rose-500 hover:bg-rose-600 text-white rounded-2xl font-semibold text-lg shadow-lg shadow-rose-500/30 transition-all cursor-pointer border-0"
              >
                ❤️ {t("Make a Donation")}
              </motion.button>

              <p className="text-sm text-rose-600 dark:text-rose-300 italic">
                {t("donation-footer")}
              </p>
            </div>
          </motion.section>

          {/* Copyright Footer */}
          <motion.footer
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="border-t border-zinc-200 dark:border-zinc-800 pt-12 sm:pt-16 mt-12 sm:mt-16 text-center"
          >
            <div className="space-y-4">
              <p className="text-sm sm:text-base text-zinc-700 dark:text-zinc-300 font-light">
                <span className="font-semibold text-zinc-900 dark:text-white">
                  {t("Maxin Labs Solutions")}
                </span>
              </p>
              <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-400">
                {t("Copyright footer")}
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-500 italic">
                {t("Built with precision and care")}
              </p>
            </div>
          </motion.footer>
        </div>
      </main>
    </div>
  );
}