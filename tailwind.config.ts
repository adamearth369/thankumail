// WHERE TO PASTE: tailwind.config.ts
// ACTION: Full file replacement (paste exactly)

import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./client/index.html",
    "./client/src/**/*.{js,ts,jsx,tsx}",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./server/**/*.{js,ts,jsx,tsx}",
    "./shared/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // ThankuMail Palette (Warm + Sacred)
        tm: {
          forest: "#173726",    // deeper grounding
          cream: "#F6F1E8",
          amber: "#B88A2A",     // burnished gratitude
          honey: "#E6C27A",     // soft glow highlight
          charcoal: "#2A2A2A",
        },

        // Semantic mapping
        background: "#F6F1E8",
        foreground: "#2A2A2A",

        // Primary actions = sacred gratitude (amber)
        primary: {
          DEFAULT: "#B88A2A",
          foreground: "#1A1A1A",
        },

        // Accent = grounding forest (used for quiet emphasis)
        accent: {
          DEFAULT: "#173726",
          foreground: "#F6F1E8",
        },

        muted: {
          DEFAULT: "#EEE6DA",
          foreground: "#4B4B4B",
        },

        card: {
          DEFAULT: "#FFFCF6",
          foreground: "#2A2A2A",
        },

        border: "#E5D9C8",
        ring: "#E6C27A",
      },

      borderRadius: {
        xl: "16px",
        "2xl": "20px",
      },

      boxShadow: {
        soft: "0 10px 30px rgba(0,0,0,0.08)",
      },
    },
  },
  plugins: [],
} satisfies Config;
