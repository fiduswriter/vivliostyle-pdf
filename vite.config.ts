import {defineConfig} from "vite"

export default defineConfig({
    // GitHub Pages serves the site at https://<user>.github.io/vivliostyle-pdf/
    base: "/vivliostyle-pdf/",
    build: {
        outDir: "dist",
        // vivliostyle is large; keep the chunk-size warning quiet
        chunkSizeWarningLimit: 2000
    }
})
