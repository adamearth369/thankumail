/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        tm: {
          forest: "#1F3D2B",
          cream: "#F6F1E8",
          gold: "#C9A227",
          charcoal: "#2A2A2A",
        },

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
};
