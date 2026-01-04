import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { insertGiftSchema, type InsertGift } from "@shared/schema";
import { useCreateGift } from "@/hooks/use-gifts";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Gift, Loader2, DollarSign, Send, Copy, Check } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import confetti from "canvas-confetti";

export function CreateGiftForm() {
  const createGift = useCreateGift();
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Extend schema for form handling (amount is number but input might be string initially)
  const form = useForm<InsertGift>({
    resolver: zodResolver(insertGiftSchema),
    defaultValues: {
      recipientEmail: "",
      message: "",
      amount: 1000,
    },
  });

  const onSubmit = (data: InsertGift) => {
    createGift.mutate(data, {
      onSuccess: (gift) => {
        const link = `${window.location.origin}/claim/${gift.publicId}`;
        setCreatedLink(link);
        confetti({
          particleCount: 100,
          spread: 70,
          origin: { y: 0.6 },
          colors: ['#8B5CF6', '#F59E0B', '#14B8A6']
        });
      },
    });
  };

  const copyToClipboard = () => {
    if (createdLink) {
      navigator.clipboard.writeText(createdLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      
      // Mini confetti burst on copy button
      const btn = document.getElementById("copy-btn");
      if (btn) {
        const rect = btn.getBoundingClientRect();
        confetti({
          particleCount: 30,
          spread: 40,
          origin: {
            x: (rect.left + rect.width / 2) / window.innerWidth,
            y: (rect.top + rect.height / 2) / window.innerHeight
          }
        });
      }
    }
  };

  if (createdLink) {
    return (
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-3xl p-8 shadow-xl shadow-primary/5 border border-primary/10 text-center space-y-6"
      >
        <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-bounce">
          <Gift className="w-10 h-10 text-green-600" />
        </div>
        
        <div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2 font-display">Your thank-you has been sent 💙</h2>
          <p className="text-gray-500">Share this magic link with your friend.</p>
        </div>

        <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex items-center gap-3 group hover:border-primary/30 transition-colors">
          <code className="text-sm text-slate-600 flex-1 truncate font-mono bg-transparent">
            {createdLink}
          </code>
          <button
            id="copy-btn"
            onClick={copyToClipboard}
            className="p-2 hover:bg-white rounded-lg transition-colors text-slate-500 hover:text-primary shadow-sm"
          >
            {copied ? <Check className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}
          </button>
        </div>

        <button
          onClick={() => {
            setCreatedLink(null);
            form.reset();
          }}
          className="text-sm text-slate-400 hover:text-primary font-medium underline decoration-2 underline-offset-4"
        >
          Send another gift
        </button>
      </motion.div>
    );
  }

  return (
    <div className="bg-white rounded-3xl p-6 md:p-8 shadow-xl shadow-primary/5 border border-primary/10 relative overflow-hidden">
      {/* Decorative gradient blob */}
      <div className="absolute top-0 right-0 w-64 h-64 bg-secondary/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />

      <div className="flex items-center gap-3 mb-8 relative z-10">
        <div className="p-3 bg-primary/10 rounded-xl text-primary">
          <Send className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-gray-900 font-display">Send a Thank You</h2>
          <p className="text-sm text-gray-500">Make someone's day special</p>
        </div>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 relative z-10">
          <FormField
            control={form.control}
            name="amount"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-gray-700 font-bold ml-1">Optional gift amount</FormLabel>
                <FormControl>
                  <div className="relative group">
                    <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 group-focus-within:text-primary transition-colors" />
                    <Input 
                      type="number" 
                      placeholder="10" 
                      className="pl-12 text-lg font-bold font-display" 
                      {...field}
                      onChange={(e) => field.onChange(Number(e.target.value) * 100)}
                      value={field.value / 100}
                    />
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="recipientEmail"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-gray-700 font-bold ml-1">Recipient’s email</FormLabel>
                <FormControl>
                  <Input placeholder="friend@example.com" className="font-medium" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="message"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-gray-700 font-bold ml-1">Your message (what do you want to say?)</FormLabel>
                <FormControl>
                  <div className="space-y-2">
                    <Textarea 
                      placeholder="Thanks for being awesome! Here's a little treat for you..." 
                      className="min-h-[120px] resize-none font-hand text-xl leading-relaxed bg-amber-50/30 border-amber-100 focus:border-amber-300 focus:ring-amber-100" 
                      {...field} 
                    />
                    <div className="flex justify-between text-xs font-medium">
                      <span className="text-slate-400">Keep it short and sincere. This will be delivered exactly as written.</span>
                      <span className="text-slate-400">Up to 500 characters</span>
                    </div>
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="space-y-3">
            <button
              type="submit"
              disabled={createGift.isPending}
              className="w-full btn-primary py-4 text-lg flex items-center justify-center gap-2 group"
            >
              {createGift.isPending ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Sending…
                </>
              ) : (
                <>
                  Send a Thank You
                  <Gift className="w-5 h-5 group-hover:rotate-12 transition-transform" />
                </>
              )}
            </button>
            <p className="text-center text-xs font-medium text-slate-400">
              Anonymous by default • No signup required
            </p>
          </div>
          {createGift.isError && (
            <p className="text-center text-sm font-medium text-destructive">
              Something went wrong. Please try again in a moment.
            </p>
          )}
        </form>
      </Form>
    </div>
  );
}
