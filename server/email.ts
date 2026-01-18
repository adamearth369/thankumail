import nodemailer from "nodemailer";

/**
 * NOTE:
 * - Uses SMTP env vars (Brevo-compatible)
 * - Keeps a single transport instance
 * - Provides: sendGiftEmail, sendReminderEmail, sendReturnToSenderEmail
 */

function env(name: string, fallback = ""): string {
  return (process.env[name] || fallback).trim();
}

const SMTP_HOST = env("SMTP_HOST", "smtp-relay.brevo.com");
const SMTP_PORT = parseInt(env("SMTP_PORT", "587"), 10);
const SMTP_USER = env("SMTP_USER"); // Brevo SMTP login
const SMTP_PASS = env("SMTP_PASS"); // Brevo SMTP key
const EMAIL_FROM = env("EMAIL_FROM", env("SMTP_FROM", "no-reply@thankumail.com"));
const EMAIL_REPLY_TO = env("EMAIL_REPLY_TO", "");

const transport = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

function safeStr(v: any) {
  return typeof v === "string" ? v : "";
}

function subjectPrefix() {
  const p = env("EMAIL_SUBJECT_PREFIX");
  return p ? `${p} ` : "";
}

async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}) {
  const to = safeStr(opts.to).trim();
  if (!to) throw new Error("Missing to");

  await transport.sendMail({
    from: EMAIL_FROM,
    to,
    replyTo: EMAIL_REPLY_TO || undefined,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });
}

/**
 * Original gift email (existing behavior)
 */
export async function sendGiftEmail(args: {
  to: string;
  claimUrl: string;
  message: string;
  amountCents?: number;
}) {
  const claimUrl = safeStr(args.claimUrl);
  const message = safeStr(args.message);

  const subject = `${subjectPrefix()}You’ve received a ThankuMail`;
  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; line-height:1.5;">
    <h2 style="margin:0 0 12px 0;">You’ve received a ThankuMail</h2>
    <p style="margin:0 0 12px 0;">A message was sent to you:</p>
    <div style="padding:12px 14px; border:1px solid #e5e7eb; border-radius:10px; background:#fafafa; margin:0 0 16px 0;">
      ${message ? `<div style="white-space:pre-wrap;">${escapeHtml(message)}</div>` : `<em>(No message)</em>`}
    </div>
    <a href="${claimUrl}" style="display:inline-block; padding:12px 16px; border-radius:10px; text-decoration:none; background:#111827; color:#fff;">
      Open your ThankuMail
    </a>
    <p style="margin:16px 0 0 0; color:#6b7280; font-size:13px;">
      If you don’t see it, check your spam/junk folder.
    </p>
  </div>`;

  const text = `You’ve received a ThankuMail.\n\nMessage:\n${message}\n\nOpen: ${claimUrl}\n\nIf you don’t see it, check your spam/junk folder.`;

  await sendMail({ to: args.to, subject, html, text });
}

/**
 * Reminder email (used by /api/reminders/run)
 */
export async function sendReminderEmail(args: {
  to: string;
  claimUrl: string;
  message: string;
  reminderNumber: number; // 1..3
}) {
  const claimUrl = safeStr(args.claimUrl);
  const message = safeStr(args.message);
  const n = Math.max(1, Math.min(3, args.reminderNumber || 1));

  const subject = `${subjectPrefix()}Reminder ${n}/3: Your ThankuMail is waiting`;
  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; line-height:1.5;">
    <h2 style="margin:0 0 12px 0;">Your ThankuMail is still waiting</h2>
    <p style="margin:0 0 12px 0;">This is reminder ${n} of 3.</p>
    <div style="padding:12px 14px; border:1px solid #e5e7eb; border-radius:10px; background:#fafafa; margin:0 0 16px 0;">
      ${message ? `<div style="white-space:pre-wrap;">${escapeHtml(message)}</div>` : `<em>(No message)</em>`}
    </div>
    <a href="${claimUrl}" style="display:inline-block; padding:12px 16px; border-radius:10px; text-decoration:none; background:#111827; color:#fff;">
      Open your ThankuMail
    </a>
    <p style="margin:16px 0 0 0; color:#6b7280; font-size:13px;">
      If you already claimed it, you can ignore this.
    </p>
  </div>`;

  const text = `Reminder ${n}/3: Your ThankuMail is waiting.\n\nMessage:\n${message}\n\nOpen: ${claimUrl}\n\nIf you already claimed it, you can ignore this.`;

  await sendMail({ to: args.to, subject, html, text });
}

/**
 * Return-to-sender email (after 3 reminders, still unclaimed)
 */
export async function sendReturnToSenderEmail(args: {
  to: string;
  recipientEmail: string;
  publicId: string;
  createdAtIso?: string;
  claimUrl?: string;
  remindersAttempted?: number;
}) {
  const to = safeStr(args.to);
  const recipientEmail = safeStr(args.recipientEmail);
  const publicId = safeStr(args.publicId);
  const createdAtIso = safeStr(args.createdAtIso);
  const claimUrl = safeStr(args.claimUrl);
  const remindersAttempted = typeof args.remindersAttempted === "number" ? args.remindersAttempted : 3;

  const subject = `${subjectPrefix()}Your ThankuMail wasn’t claimed`;
  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; line-height:1.5;">
    <h2 style="margin:0 0 12px 0;">Your ThankuMail wasn’t claimed</h2>
    <p style="margin:0 0 12px 0;">
      We tried notifying <strong>${escapeHtml(recipientEmail)}</strong> up to ${remindersAttempted} times, but it wasn’t claimed.
    </p>
    <div style="padding:12px 14px; border:1px solid #e5e7eb; border-radius:10px; background:#fafafa; margin:0 0 16px 0;">
      <div><strong>Gift ID:</strong> ${escapeHtml(publicId)}</div>
      ${createdAtIso ? `<div><strong>Created:</strong> ${escapeHtml(createdAtIso)}</div>` : ``}
    </div>
    ${claimUrl ? `<p style="margin:0 0 12px 0;">If you want to resend manually, you can use this link:</p>
    <a href="${claimUrl}" style="display:inline-block; padding:12px 16px; border-radius:10px; text-decoration:none; background:#111827; color:#fff;">
      View the ThankuMail link
    </a>` : ``}
    <p style="margin:16px 0 0 0; color:#6b7280; font-size:13px;">
      This is an automated notice.
    </p>
  </div>`;

  const text = `Your ThankuMail wasn’t claimed.\n\nRecipient: ${recipientEmail}\nGift ID: ${publicId}\nCreated: ${createdAtIso}\nReminders attempted: ${remindersAttempted}\n${claimUrl ? `\nLink: ${claimUrl}\n` : ""}`;

  await sendMail({ to, subject, html, text });
}

function escapeHtml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
