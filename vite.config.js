// Two builds from one source:
//   vite build --mode single  → dist/index.html, ONE self-contained file (JS and CSS inlined),
//                               so the piece can be shared as a single page
//   vite build                → dist-site/, a normal multi-file site
// base './' keeps every asset path relative, so either output works from any folder or host.
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    base: './',
    plugins: single ? [viteSingleFile()] : [],
    build: {
      outDir: single ? 'dist' : 'dist-site',
      emptyOutDir: true,
      // three.js alone is ~700 kB minified; one chunk is the point of this piece
      chunkSizeWarningLimit: 1500,
    },
    server: { port: 5191 },
    preview: { port: 5196 },
  };
});
