// WHERE TO PASTE: client/tailwind.config.js
// ACTION: Full file replacement (paste exactly)

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "../shared/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Keep class names the same, but shift the "cream" vibe to a soft lavender
        tm: {
          forest: "#1F3B2C",
          cream: "#F3EEFF", // light purple (replaces cream)
          amber: "#F2B84B",
          honey: "#E9C46A",
          charcoal: "#1F2937",
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
        outfit: ["Outfit", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
