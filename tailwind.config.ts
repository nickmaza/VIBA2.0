import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        term: {
          bg: "#000000",
          panel: "#0a0a0a",
          panel2: "#111111",
          border: "#2a2a28",
          borderStrong: "#3d3d3a",
          text: "#e8e8e2",
          dim: "#87867e",
          amber: "#ff9d2e",
          amberDim: "#a86a1f",
          green: "#2ecc40",
          red: "#ff4136",
          cyan: "#39cccc",
          yellow: "#ffd93d",
        },
      },
      fontFamily: {
        mono: ["var(--font-plex-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        sans: ["var(--font-plex-sans)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
