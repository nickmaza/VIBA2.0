import type { Config } from "tailwindcss";

// Palette modelled on a dense desktop trading workstation: near-black app
// background, slightly lighter panel bodies, gray title bars, hairline borders,
// and a single brand-green accent stripe under the menu bar.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        term: {
          bg: "#0b0b0b",
          panel: "#141414",
          panel2: "#1d1d1d",
          title: "#2b2b2b",
          border: "#3a3a3a",
          borderStrong: "#5a5a5a",
          text: "#e6e6e6",
          dim: "#9c9c9c",
          amber: "#f5c542",
          amberDim: "#a8862a",
          green: "#3fbf4a",
          red: "#e5453c",
          cyan: "#4fb3e8",
          yellow: "#f5d033",
          brand: "#6cb33f",
          ink: "#2f3540", // highlighted "strike"-style column
        },
      },
      fontFamily: {
        mono: ["var(--font-plex-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        sans: ["var(--font-plex-sans)", "Segoe UI", "Tahoma", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
