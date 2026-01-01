import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { useGift, useClaimGift } from "@/hooks/use-gifts";
import { Loader2, Gift, CheckCircle, AlertCircle, ArrowRight } from "lucide-react";
import { motion } from "framer-motion";
import confetti from "canvas-confetti";
import { format } from "date-fns";

export default function ClaimGift() {
  const [match, params] = useRoute("/claim/:publicId");
  const publicId = params?.publicId || "";
  
  const { data: gift, isLoading, error } = useGift(publicId);
  const claimMutation = useClaimGift();
  const [isOpened, setIsOpened] = useState(false);

  // Trigger confetti when gift is successfully loaded and claimed or just opened
  useEffect(() => {
    if (gift?.isClaimed && !isLoading) {
      setIsOpened(true);
    }
  }, [gift, isLoading]);

  const handleClaim = () => {
    claimMutation.mutate(publicId, {
      onSuccess: () => {
        confetti({
          particleCount: 150,
          spread: 70,
          origin: { y: 0.6 },
          colors: ['#8B5CF6', '#F59E0B', '#14B8A6', '#F43F5E']
        });
      }
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin text-primary mx-auto" />
          <p className="text-slate-500 font-medium">Unwrapping gift...</p>
        </div>
      </div>
    );
  }

  // Handle 404 or errors
  if (!gift || error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-3xl p-8 shadow-xl text-center border border-red-100">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8 text-red-500" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 font-display mb-2">Gift Not Found</h1>
          <p className="text-slate-500 mb-6">
            We couldn't find this gift. The link might be invalid or expired.
          </p>
          <a href="/" className="btn-secondary w-full py-3 inline-block">
            Go Home
          </a>
        </div>
      </div>
    );
  }

  const isClaimed = gift.isClaimed;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 md:p-8 relative overflow-hidden">
      {/* Background Decor */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden -z-10 pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-primary/5 rounded-full blur-3xl animate-float" />
        <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-secondary/5 rounded-full blur-3xl animate-float-delayed" />
      </div>

      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="max-w-lg w-full bg-white rounded-[2rem] shadow-2xl shadow-primary/10 border border-white/50 overflow-hidden relative"
      >
        {/* Header Color Block */}
        <div className={`h-32 ${isClaimed ? 'bg-green-500' : 'bg-primary'} relative flex items-center justify-center transition-colors duration-500`}>
          <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, white 1px, transparent 0)', backgroundSize: '20px 20px' }}></div>
          <motion.div 
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 200, delay: 0.2 }}
            className="w-20 h-20 bg-white rounded-full shadow-lg flex items-center justify-center relative z-10"
          >
            {isClaimed ? (
              <CheckCircle className="w-10 h-10 text-green-500" />
            ) : (
              <Gift className="w-10 h-10 text-primary" />
            )}
          </motion.div>
        </div>

        <div className="p-8 text-center">
          {isClaimed ? (
            <div className="space-y-6">
              <div>
                <h1 className="text-3xl font-bold font-display text-gray-900 mb-2">
                  Claimed!
                </h1>
                <p className="text-slate-500">
                  {gift.recipientEmail} claimed this gift on {gift.claimedAt ? format(new Date(gift.claimedAt), 'MMMM do, yyyy') : 'Recently'}
                </p>
              </div>

              <div className="bg-slate-50 rounded-2xl p-6 border border-slate-100">
                <p className="text-xs uppercase tracking-wider font-bold text-slate-400 mb-1">Amount</p>
                <p className="text-4xl font-black font-display text-gray-900">${gift.amount}</p>
              </div>

              <div className="bg-amber-50 rounded-xl p-6 relative">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-amber-100 px-3 py-1 rounded-full text-[10px] font-bold text-amber-600 uppercase tracking-wide">
                  Message
                </div>
                <p className="font-hand text-2xl text-slate-800 leading-relaxed">
                  "{gift.message}"
                </p>
              </div>

              <a href="/" className="btn-secondary w-full py-3 flex items-center justify-center gap-2 mt-4">
                Send your own gift <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          ) : (
            <div className="space-y-8">
              <div>
                <h1 className="text-3xl font-bold font-display text-gray-900 mb-2">
                  You've got a gift!
                </h1>
                <p className="text-slate-500">
                  Someone special sent you a little surprise.
                </p>
              </div>

              <div className="py-2">
                <span className="inline-block px-4 py-2 bg-primary/5 rounded-full text-primary font-bold text-sm mb-4">
                  From Unknown Sender
                </span>
                
                <div className="relative">
                  <div className="absolute -left-2 -top-4 text-4xl text-slate-200 font-serif">"</div>
                  <p className="font-hand text-3xl text-slate-700 px-4 leading-relaxed">
                    {gift.message}
                  </p>
                  <div className="absolute -right-2 -bottom-8 text-4xl text-slate-200 font-serif rotate-180">"</div>
                </div>
              </div>

              <div className="pt-4">
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
                        Claim ${gift.amount}
                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                      </>
                    )}
                  </span>
                  
                  {/* Shiny effect on hover */}
                  <div className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-1000 bg-gradient-to-r from-transparent via-white/20 to-transparent z-0" />
                </button>
                <p className="text-xs text-slate-400 mt-3">
                  Clicking claim will simulate a transfer to {gift.recipientEmail}
                </p>
              </div>
            </div>
          )}
        </div>
      </motion.div>

      {/* Footer Branding */}
      <div className="mt-8 opacity-50 hover:opacity-100 transition-opacity">
        <a href="/" className="flex items-center gap-2 text-slate-500">
          <Gift className="w-4 h-4" />
          <span className="text-sm font-bold font-display">ThankuMail</span>
        </a>
      </div>
    </div>
  );
}
