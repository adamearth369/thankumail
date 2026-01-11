         import nodemailer from "nodemailer";

         type SendGiftEmailArgs = {
           to: string;
           claimLink: string; // can be relative "/claim/abc" or absolute
           message: string;
           amountCents: number;
         };

         type SendGiftEmailResult =
           | { ok: true; messageId: string }
           | { ok: false; error: string };

         function env(name: string, fallback = "") {
           const v = process.env[name];
           return (v ?? fallback).trim();
         }

         function asInt(value: string, fallback: number) {
           const n = Number(value);
           return Number.isFinite(n) ? n : fallback;
         }

         function isEmail(s: string) {
           return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
         }

         function toAbsoluteClaimLink(claimLink: string) {
           if (!claimLink) return claimLink;
           if (/^https?:\/\//i.test(claimLink)) return claimLink;

           const base = env("BASE_URL", "").replace(/\/+$/, "");
           if (!base) return claimLink;

           const path = claimLink.startsWith("/") ? claimLink : `/${claimLink}`;
           return `${base}${path}`;
         }

         function escapeHtml(input: string) {
           return input
             .replaceAll("&", "&amp;")
             .replaceAll("<", "&lt;")
             .replaceAll(">", "&gt;")
             .replaceAll('"', "&quot;")
             .replaceAll("'", "&#039;");
         }

         function logEmail(event: string, fields: Record<string, any> = {}) {
           console.log(
             JSON.stringify({
               ts: new Date().toISOString(),
               event,
               ...fields,
             }),
           );
         }

         function sleep(ms: number) {
           return new Promise((r) => setTimeout(r, ms));
         }

         export async function sendGiftEmail(args: SendGiftEmailArgs): Promise<SendGiftEmailResult> {
           const started = Date.now();

           try {
             const to = (args.to || "").trim();
             if (!isEmail(to)) {
               return { ok: false, error: `Invalid recipient email: "${to}"` };
             }

             const smtpKey = env("BREVO_SMTP_KEY") || env("BREVO_API_KEY");
             if (!smtpKey) {
               return { ok: false, error: "Missing BREVO_SMTP_KEY (or BREVO_API_KEY)" };
             }

             const host = env("SMTP_HOST", "smtp-relay.brevo.com");
             const port = asInt(env("SMTP_PORT", "587"), 587);

             // Brevo recommends STARTTLS on 587; do NOT set secure=true for 587.
             // If you want SMTPS, set SMTP_PORT=465 and SMTP_SECURE=true.
             const secure = env("SMTP_SECURE", "false").toLowerCase() === "true";

             // Brevo SMTP user is typically literally "apikey"
             const user = env("BREVO_SMTP_LOGIN", "apikey");

             // Must be a verified sender in Brevo (or domain authenticated)
             const fromEmail = env("FROM_EMAIL", "noreply@thankumail.com");
             const fromName = env("FROM_NAME", "ThankuMail");

             const dollars = (args.amountCents / 100).toFixed(2);
             const claimUrl = toAbsoluteClaimLink(args.claimLink);

             const subject = `You received a ThanküMail gift ($${dollars})`;
             const text = [
               `You received a ThanküMail gift!`,
               ``,
               `Amount: $${dollars}`,
               `Message: ${args.message}`,
               ``,
               `Claim here: ${claimUrl}`,
             ].join("\n");

             const html = `
               <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height:1.4">
                 <h2 style="margin:0 0 12px">You received a ThanküMail gift 🎁</h2>
                 <p style="margin:0 0 8px"><b>Amount:</b> $${dollars}</p>
                 <p style="margin:0 0 8px"><b>Message:</b></p>
                 <p style="margin:0 0 16px; font-style:italic; color:#555">"${escapeHtml(args.message)}"</p>
                 <p style="margin:0 0 16px">
                   <a href="${claimUrl}" style="display:inline-block; padding:10px 14px; background:#7c3aed; color:#fff; text-decoration:none; border-radius:10px; font-weight:700">
                     Claim your gift →
                   </a>
                 </p>
                 <p style="margin:0; color:#777; font-size:13px">If you did not expect this, you can ignore this email.</p>
               </div>
             `;

             const transporter = nodemailer.createTransport({
               host,
               port,
               secure,
               auth: { user, pass: smtpKey },

               connectionTimeout: asInt(env("SMTP_CONNECTION_TIMEOUT_MS", "5000"), 5000),
               greetingTimeout: asInt(env("SMTP_GREETING_TIMEOUT_MS", "5000"), 5000),
               socketTimeout: asInt(env("SMTP_SOCKET_TIMEOUT_MS", "8000"), 8000),

               requireTLS: env("SMTP_REQUIRE_TLS", "false").toLowerCase() === "true",
               tls: {
                 rejectUnauthorized: env("SMTP_TLS_REJECT_UNAUTHORIZED", "true").toLowerCase() === "true",
               },
             });

             for (let attempt = 1; attempt <= 2; attempt++) {
               const attemptStart = Date.now();

               logEmail("email_send_start", {
                 attempt,
                 to,
                 host,
                 port,
                 secure,
                 fromEmail,
               });

               try {
                 await transporter.verify();

                 logEmail("email_verify_ok", {
                   attempt,
                   ms: Date.now() - attemptStart,
                 });

                 const info = await transporter.sendMail({
                   from: `"${fromName}" <${fromEmail}>`,
                   to,
                   subject,
                   text,
                   html,
                 });

                 logEmail("email_send_ok", {
                   attempt,
                   to,
                   messageId: info.messageId,
                   ms: Date.now() - attemptStart,
                   totalMs: Date.now() - started,
                 });

                 return { ok: true, messageId: info.messageId || "unknown" };
               } catch (err: any) {
                 const code = err?.code;
                 const msg = String(err?.message || err);

                 logEmail("email_send_attempt_failed", {
                   attempt,
                   code,
                   message: msg,
                   ms: Date.now() - attemptStart,
                 });

                 if (attempt === 1) {
                   await sleep(600);
                   continue;
                 }

                 return { ok: false, error: msg };
               }
             }

             return { ok: false, error: "Email send failed" };
           } catch (err: any) {
             const safe = {
               tag: "email_send_failed",
               message: String(err?.message || err),
               code: err?.code,
               response: err?.response,
               responseCode: err?.responseCode,
             };
             console.error(JSON.stringify(safe));
             return { ok: false, error: safe.message };
           }
         }
