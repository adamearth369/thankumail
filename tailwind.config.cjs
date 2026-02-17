// WHERE TO PASTE: tailwind.config.cjs
// ACTION: Full file replacement (paste exactly)

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./client/index.html",
    "./client/src/**/*.{js,ts,jsx,tsx}",
    "./shared/**/*.{js,ts,jsx,tsx}",
    "./server/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        tm: {
          forest: "#1F3D2B",
          cream: "#F6F1E8",
          amber: "#F3C969",
          honey: "#D9B44A",
          charcoal: "#2A2A2A",
          card: "#FFFFFF",
        },
      },
      borderRadius: {
        xl: "1rem",
        "2xl": "1.25rem",
      },
      boxShadow: {
        soft: "0 10px 30px rgba(0,0,0,0.08)",
      },
      fontFamily: {
        body: ["DM Sans", "ui-sans-serif", "system-ui", "sans-serif"],
        outfit: ["Outfit", "ui-sans-serif", "system-ui", "sans-serif"],
        quicksand: ["Quicksand", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
