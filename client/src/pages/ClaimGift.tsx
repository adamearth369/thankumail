// WHERE TO PASTE: client/src/pages/ClaimGift.tsx
// ACTION: Full file replacement (paste exactly)

import { useEffect, useMemo, useState } from "react";
import { useRoute } from "wouter";
import { useGift, useClaimGift } from "@/hooks/use-gifts";
import { Loader2, Gift, CheckCircle, AlertCircle, ArrowRight, ShieldCheck } from "lucide-react";
import { motion } from "framer-motion";
import confetti from "canvas-confetti";
import { format } from "date-fns";

function money(cents: any) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "$0.00";
  return `$${(n / 100).toFixed(2)}`;
}

function safeEmail(v: any) {
  const s = String(v || "").trim();
  if (!s) return "";
  const at = s.indexOf("@");
  if (at <= 1) return s;
  return `${s.slice(0, 1)}***${s.slice(at)}`;
}

export default function ClaimGift() {
  const [match, params] = useRoute("/claim/:publicId");
  const publicId = params?.publicId || "";

  const { data: gift, isLoading, error } = useGift(publicId);
  const claimMutation = useClaimGift();

  const [justClaimed, setJustClaimed] = useState(false);

  const isClaimed = Boolean(gift?.isClaimed);

  const claimedDate = useMemo(() => {
    if (!gift?.claimedAt) return "";
    try {
      return format(new Date(gift.claimedAt), "MMMM do, yyyy");
    } catch {
      return "";
    }
  }, [gift?.claimedAt]);

  const amountLabel = useMemo(() => money(gift?.amount), [gift?.amount]);

  // Confetti only when YOU successfully claim (not when visiting an already-claimed link)
  useEffect(() => {
    if (!justClaimed) return;
    confetti({
      particleCount: 140,
      spread: 70,
      origin: { y: 0.6 },
    });
  }, [justClaimed]);

  const handleClaim = () => {
    if (!publicId) return;

    claimMutation.mutate(publicId, {
      onSuccess: () => {
        setJustClaimed(true);
      },
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto" />
          <p className="text-slate-500 font-medium">Opening your ThankuMail…</p>
        </div>
      </div>
    );
  }

  if (!gift || error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-3xl p-8 shadow-xl text-center border border-red-100">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8 text-red-500" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 font-display mb-2">We couldn’t find this ThankuMail</h1>
          <p className="text-slate-500 mb-6">The link may be invalid, expired, or already completed.</p>
          <a href="/" className="btn-secondary w-full py-3 inline-block">
            Go Home
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 md:p-8 relative overflow-hidden">
      {/* Background Decor */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-primary/5 rounded-full blur-3xl animate-float" />
        <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-secondary/5 rounded-full blur-3xl animate-float-delayed" />
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.45 }}
        className="max-w-lg w-full bg-white rounded-[2rem] shadow-2xl shadow-primary/10 border border-white/50 overflow-hidden relative"
      >
        {/* Header */}
        <div
          className={`h-32 ${isClaimed ? "bg-green-500" : "bg-primary"} relative flex items-center justify-center transition-colors duration-500`}
        >
          <div
            className="absolute inset-0 opacity-20"
            style={{
              backgroundImage: "radial-gradient(circle at 2px 2px, white 1px, transparent 0)",
              backgroundSize: "20px 20px",
            }}
          />
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 200, delay: 0.15 }}
            className="w-20 h-20 bg-white rounded-full shadow-lg flex items-center justify-center relative z-10"
          >
            {isClaimed ? <CheckCircle className="w-10 h-10 text-green-500" /> : <Gift className="w-10 h-10 text-primary" />}
          </motion.div>
        </div>

        <div className="p-8 text-center">
          {/* --- CLAIMED STATE --- */}
          {isClaimed ? (
            <div className="space-y-6">
              <div>
                <h1 className="text-3xl font-bold font-display text-gray-900 mb-2">Claimed</h1>
                <p className="text-slate-500">
                  {claimedDate ? `Completed on ${claimedDate}.` : "Completed recently."}
                </p>
              </div>

              <div className="bg-slate-50 rounded-2xl p-6 border border-slate-100">
                <p className="text-xs uppercase tracking-wider font-bold text-slate-400 mb-1">Gift amount</p>
                <p className="text-4xl font-black font-display text-gray-900">{amountLabel}</p>
              </div>

              <div className="bg-slate-50 rounded-xl p-6 border border-slate-100 text-left">
                <p className="text-xs uppercase tracking-wider font-bold text-slate-400 mb-2">Message</p>
                <p className="font-hand text-2xl text-slate-800 leading-relaxed break-words">“{gift.message}”</p>
              </div>

              <a href="/" className="btn-secondary w-full py-3 flex items-center justify-center gap-2 mt-4">
                Send a ThankuMail <ArrowRight className="w-4 h-4" />
              </a>

              <div className="text-xs text-slate-400 flex items-center justify-center gap-2">
                <ShieldCheck className="w-4 h-4" />
                This link can’t be claimed twice.
              </div>
            </div>
          ) : (
            /* --- UNCLAIMED STATE --- */
            <div className="space-y-8">
              <div>
                <h1 className="text-3xl font-bold font-display text-gray-900 mb-2">A note for you</h1>
                <p className="text-slate-500">Read the message first. Claim when you’re ready.</p>
              </div>

              <div className="py-2">
                <span className="inline-block px-4 py-2 bg-primary/5 rounded-full text-primary font-bold text-sm mb-4">
                  From someone who cares
                </span>

                <div className="relative">
                  <div className="absolute -left-2 -top-4 text-4xl text-slate-200 font-serif">"</div>
                  <p className="font-hand text-3xl text-slate-700 px-4 leading-relaxed break-words">{gift.message}</p>
                  <div className="absolute -right-2 -bottom-8 text-4xl text-slate-200 font-serif rotate-180">"</div>
                </div>
              </div>

              <div className="bg-slate-50 rounded-2xl p-6 border border-slate-100">
                <p className="text-xs uppercase tracking-wider font-bold text-slate-400 mb-1">Gift</p>
                <p className="text-4xl font-black font-display text-gray-900">{amountLabel}</p>
                <p className="text-xs text-slate-400 mt-2 flex items-center justify-center gap-2">
                  <ShieldCheck className="w-4 h-4" />
                  Quick verification + a short pause keeps it safe.
                </p>
              </div>

              <div className="pt-2">
                <button
                  onClick={handleClaim}
                  disabled={claimMutation.isPending}
                  className="w-full btn-primary py-4 text-xl shadow-xl shadow-primary/30 group relative overflow-hidden"
                >
                  <span className="relative z-10 flex items-center justify-center gap-2">
                    {claimMutation.isPending ? (
                      <Loader2 className="w-6 h-6 animate-spin" />
                    ) : (
                      <>
                        Claim {amountLabel}
                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                      </>
                    )}
                  </span>

                  <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-1000 bg-gradient-to-r from-transparent via-white/20 to-transparent z-0" />
                </button>

                <p className="text-xs text-slate-400 mt-3">
                  If you weren’t expecting this, you can ignore it — nothing else is required.
                </p>
              </div>

              {!!gift?.recipientEmail && (
                <p className="text-[11px] text-slate-400">
                  Sent to: <span className="font-mono">{safeEmail(gift.recipientEmail)}</span>
                </p>
              )}
            </div>
          )}
        </div>
      </motion.div>

      {/* Footer Branding */}
      <div className="mt-8 opacity-60 hover:opacity-100 transition-opacity">
        <a href="/" className="flex items-center gap-2 text-slate-500">
          <Gift className="w-4 h-4" />
          <span className="text-sm font-bold font-display">
            Thank<span className="text-primary">ü</span>
            <span className="text-primary">Mail</span>
          </span>
        </a>
      </div>
    </div>
  );
}
