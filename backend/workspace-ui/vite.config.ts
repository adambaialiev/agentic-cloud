import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * early-read.ts is its OWN tiny script (follow-up to note #825): it starts a
 * deep link's first read while the shell's script is still downloading, so
 * it must not be folded into that script — which is what Vite does with
 * every module script in index.html. So it is a separate build entry, and
 * this puts its hashed file in the built page AHEAD of the shell's, as a
 * module script (deferred like the shell's, run in document order, and
 * never waiting on the shell's download). A file, not inline: the CSP is
 * `script-src 'self'`.
 */
function earlyReadFirst(): Plugin {
  return {
    name: 'early-read-first',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const chunk = Object.values(ctx.bundle ?? {}).find((item) => item.type === 'chunk' && item.isEntry && item.name === 'early');
        if (!chunk) throw new Error('early-read entry missing from the build');
        if (chunk.type === 'chunk' && chunk.imports.length) throw new Error(`early-read must import nothing; it imports ${chunk.imports.join(', ')}`);
        // Immediately before the shell's own script: module scripts run in
        // document order, so placed after it this would wait for its download.
        const shell = html.indexOf('<script type="module"');
        if (shell < 0) throw new Error('no module script in the built index.html to put early-read ahead of');
        const tag = `<script type="module" crossorigin src="/workspace/app/${chunk.fileName}"></script>\n  `;
        return html.slice(0, shell) + tag + html.slice(shell);
      },
    },
  };
}

// The React Workspace shell. Built by `npm run build` in backend/ into
// dist/workspace-ui, where routes/workspace-ui.ts serves index.html at every
// Workspace address and the hashed assets under /workspace/app/assets.
export default defineConfig({
  root: here,
  base: '/workspace/app/',
  plugins: [react(), earlyReadFirst()],
  build: {
    outDir: fileURLToPath(new URL('../dist/workspace-ui', import.meta.url)),
    emptyOutDir: true,
    // The shell's CSP is `script-src 'self'` with no inline hashes; the
    // preload polyfill is imported from the entry chunk, not inlined, but
    // nothing here needs it and less is easier to keep honest.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        early: fileURLToPath(new URL('src/early-read.ts', import.meta.url)),
      },
      // The early entry's exports are for its tests; keep them as written.
      preserveEntrySignatures: 'allow-extension',
    },
  },
});
