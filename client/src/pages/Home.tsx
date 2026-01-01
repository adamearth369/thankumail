import { CreateGiftForm } from "@/components/CreateGiftForm";
import { motion } from "framer-motion";
import { Heart, Sparkles, Coffee } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen pb-20 overflow-x-hidden">
      {/* Navigation / Header */}
      <header className="py-6 px-4 md:px-8 border-b border-white/50 bg-white/30 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center text-white shadow-lg shadow-primary/20">
              <Heart className="w-6 h-6 fill-current" />
            </div>
            <span className="text-xl font-bold font-display tracking-tight text-gray-900">
              Thanku<span className="text-primary">Mail</span>
            </span>
          </div>
          <a href="https://github.com" target="_blank" rel="noreferrer" className="text-sm font-bold text-slate-500 hover:text-primary transition-colors">
            About Us
          </a>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-12 md:py-20">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          
          {/* Left Column: Hero Text */}
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
            className="space-y-8"
          >
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-white rounded-full shadow-sm border border-slate-100 text-sm font-bold text-slate-600">
              <Sparkles className="w-4 h-4 text-secondary" />
              <span>The easiest way to say thanks</span>
            </div>
            
            <h1 className="text-5xl md:text-7xl font-extrabold font-display leading-[1.1] text-gray-900">
              Send a little <br/>
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent relative">
                happiness.
                <svg className="absolute w-full h-3 -bottom-1 left-0 text-secondary/30 -z-10" viewBox="0 0 100 10" preserveAspectRatio="none">
                  <path d="M0 5 Q 50 10 100 5" stroke="currentColor" strokeWidth="8" fill="none" />
                </svg>
              </span>
            </h1>
            
            <p className="text-xl text-slate-600 leading-relaxed max-w-lg">
              Create a digital gift card in seconds. Send money with a personal note to anyone, anywhere. No account required.
            </p>

            <div className="flex items-center gap-6 pt-4">
              <div className="flex -space-x-3">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="w-10 h-10 rounded-full border-2 border-white bg-slate-200 overflow-hidden">
                    {/* Placeholder avatars */}
                    <img 
                      src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${i*13}`} 
                      alt="User" 
                      className="w-full h-full bg-slate-100"
                    />
                  </div>
                ))}
              </div>
              <div className="text-sm font-medium text-slate-500">
                <strong className="text-gray-900">1,200+</strong> gifts sent this week
              </div>
            </div>

            {/* Fun decorative elements */}
            <div className="hidden lg:block relative h-32 w-full">
              <motion.div 
                className="absolute left-0 top-4 bg-white p-3 rounded-2xl shadow-lg border border-slate-100 rotate-[-6deg]"
                animate={{ rotate: [-6, -4, -6], y: [0, -5, 0] }}
                transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
              >
                <Coffee className="w-6 h-6 text-amber-500 mb-1" />
                <p className="text-xs font-bold text-slate-400">Coffee's on me!</p>
                <p className="font-bold text-gray-900">$5.00</p>
              </motion.div>

              <motion.div 
                className="absolute left-32 top-0 bg-white p-3 rounded-2xl shadow-lg border border-slate-100 rotate-[3deg]"
                animate={{ rotate: [3, 5, 3], y: [0, -8, 0] }}
                transition={{ duration: 5, repeat: Infinity, ease: "easeInOut", delay: 1 }}
              >
                <Heart className="w-6 h-6 text-rose-500 mb-1 fill-rose-500" />
                <p className="text-xs font-bold text-slate-400">Thanks for helping</p>
                <p className="font-bold text-gray-900">$20.00</p>
              </motion.div>
            </div>
          </motion.div>

          {/* Right Column: Form */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="w-full max-w-md mx-auto lg:mx-0"
          >
            <CreateGiftForm />
          </motion.div>

        </div>
      </main>
      
      {/* Background blobs */}
      <div className="fixed top-20 left-10 w-72 h-72 bg-primary/10 rounded-full blur-[100px] -z-10 animate-float" />
      <div className="fixed bottom-20 right-10 w-96 h-96 bg-secondary/10 rounded-full blur-[120px] -z-10 animate-float-delayed" />
    </div>
  );
}
