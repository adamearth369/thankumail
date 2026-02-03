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
        // ThankuMail Palette (Warm Gratitude)
        tm: {
          forest: "#1F3D2B",
          cream: "#F6F1E8",
          gold: "#C9A227",
          charcoal: "#2A2A2A",
        },

        // Semantic mapping (use these in UI)
        background: "#F6F1E8",
        foreground: "#2A2A2A",

        primary: {
          DEFAULT: "#1F3D2B",
          foreground: "#F6F1E8",
        },

        accent: {
          DEFAULT: "#C9A227",
          foreground: "#1F3D2B",
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
        ring: "#C9A227",
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
