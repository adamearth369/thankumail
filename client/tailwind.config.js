/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./client/index.html",
    "./client/src/**/*.{js,ts,jsx,tsx}",
    "./shared/**/*.{js,ts,jsx,tsx}",
    "./server/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
