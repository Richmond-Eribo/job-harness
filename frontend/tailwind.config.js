/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Slate-based dark palette mirroring the legacy dashboard.
        ink: {
          950: "#0f172a",
          900: "#1e293b",
          800: "#334155",
          700: "#475569",
          500: "#64748b",
          300: "#cbd5e1",
          100: "#e2e8f0",
        },
        accent: "#3b82f6",
      },
    },
  },
  plugins: [],
}
