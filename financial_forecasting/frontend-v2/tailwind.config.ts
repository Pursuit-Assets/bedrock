import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

// Bedrock theme tokens — sourced from the design mockup
// (bedrock-mockup/project/Bedrock.html). Linear/Attio aesthetic:
// warm-neutral light mode, single confident-blue accent, JetBrains Mono
// for numerics, Inter for UI.
const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        // Surfaces
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        border: "hsl(var(--border))",
        "border-strong": "var(--border-strong)",

        // Ink (text)
        ink: "var(--ink)",
        "ink-2": "var(--ink-2)",
        "ink-3": "var(--ink-3)",
        "ink-4": "var(--ink-4)",

        // Accent
        accent: {
          DEFAULT: "var(--accent)",
          soft: "var(--accent-soft)",
          ink: "var(--accent-ink)",
          foreground: "hsl(var(--accent-foreground))",
        },

        // Stage palette
        "stage-lead": "var(--st-lead)",
        "stage-lead-ink": "var(--st-lead-ink)",
        "stage-qual": "var(--st-qual)",
        "stage-qual-ink": "var(--st-qual-ink)",
        "stage-ask": "var(--st-ask)",
        "stage-ask-ink": "var(--st-ask-ink)",
        "stage-prop": "var(--st-prop)",
        "stage-prop-ink": "var(--st-prop-ink)",
        "stage-contract": "var(--st-contract)",
        "stage-contract-ink": "var(--st-contract-ink)",
        "stage-won": "var(--st-won)",
        "stage-won-ink": "var(--st-won-ink)",
        "stage-lost": "var(--st-lost)",
        "stage-lost-ink": "var(--st-lost-ink)",

        // Semantic
        green: {
          DEFAULT: "var(--green)",
          soft: "var(--green-soft)",
        },
        amber: {
          DEFAULT: "var(--amber)",
          soft: "var(--amber-soft)",
        },
        red: {
          DEFAULT: "var(--red)",
          soft: "var(--red-soft)",
        },

        // shadcn-style aliases (so off-the-shelf components work)
        background: "var(--bg)",
        foreground: "var(--ink)",
        card: {
          DEFAULT: "var(--surface)",
          foreground: "var(--ink)",
        },
        popover: {
          DEFAULT: "var(--surface)",
          foreground: "var(--ink)",
        },
        primary: {
          DEFAULT: "var(--ink)",
          foreground: "var(--surface)",
        },
        secondary: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--ink)",
        },
        muted: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--ink-3)",
        },
        destructive: {
          DEFAULT: "var(--red)",
          foreground: "var(--surface)",
        },
        input: "var(--border-strong)",
        ring: "var(--accent)",
      },
      borderRadius: {
        sm: "var(--r-sm)",
        md: "var(--r-md)",
        lg: "var(--r-lg)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
    },
  },
  plugins: [animate],
};

export default config;
