import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
  },
  // Use the bundler-mode tsconfig for the UI
  // (bridge uses NodeNext tsconfig, UI needs bundler + jsx)
});
