// NEXT ACTIONABLE ITEM: DAILY SEND LIMITS (PER IP + PER EMAIL)
// WHERE TO PASTE: GitHub → thankumail repo → server/routes.ts
// ACTION: COPY/PASTE THIS ENTIRE FILE — REPLACE EVERYTHING

import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { sendGiftEmail } from "./email";

const MIN_AMOUNT_CENTS = 1000; // $10.00
const MIN_CLAIM_DELAY_MS = 60_000; // 60 seconds

// ---- DAILY LIMITS (SAFE IN-MEMORY, AUTO-RESET) ----
const DAILY_MAX_PER_IP = 20;
const DAILY_MAX_PER_EMAIL = 10;

type Counter = { count: number; resetAt: number };
const ipDaily = new Map<string, Counter>();
const emailDaily = new Map<string, Counter>();

const startOfNextDay = () => {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
};

const hitCounter = (map: Map<string, Counter>, key: string, max: number) => {
  const now = Date.now();
  const cur = map.get(key);
  if (!cur || cur.resetAt <= now) {
    map.set(key, { count: 1, resetAt: startOfNextDay() });
    return { ok: true };
  }
  cur.count += 1;
  if (cur.count > max) return { ok: false };
  return { ok: true };
};

// ---- LOGGING ----
const logEvent = (type: string, data: Record<string, any> = {}) => {
  try {
    console.log(JSON.stringify({ time: new Date().toISOString(), type, ...data }));
  } catch {}
};

const getDomain = (email: string) => {
  const at = email.lastIndexOf("@");
  if (at === -1) return "";
  return email.slice(at + 1).trim().toLowerCase();
};

const isDisposableEmail = (email: string) => {
  const enabled = String(process.env.ENABLE_DISPOSABLE_BLOCK || "").toLowerCase() === "true";
  if (!enabled) return false;
  const domain = getDomain(email);
  if (!domain) return true;
  const blocked = new Set([
    "mailinator.com",
    "guerrillamail.com",
    "guerrillamail.net",
    "guerrillamail.org",
    "tempmail.com",
    "temp-mail.org",
    "10minutemail.com",
    "10minutemail.net",
    "yopmail.com",
    "yopmail.fr",
    "yopmail.net",
  ]);
  return blocked.has(domain) || domain.includes("tempmail") || domain.includes("trashmail");
};

const escapeHtml = (s: string) =>
  String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

// ---- TURNSTILE ----
async function verifyTurnstile(token: string, ip?: string) {
  const secret = process.env.TURNSTILE_SECRET_KEY || "";
  if (!secret) return { ok: true, skipped: true as const };
  if (!token) return { ok: false };
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const data: any = await
