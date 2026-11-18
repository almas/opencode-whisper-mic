import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// Builds the GUI half (src/gui.tsx) into dist/gui-experimental.cjs, keeping the
// host's own modules (solid, the app runtime) external so the bundle shares them.
export default defineConfig({
  plugins: [gui()],
})
