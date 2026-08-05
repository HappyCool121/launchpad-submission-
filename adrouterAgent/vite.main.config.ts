import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    __ADROUTER_E2E__: JSON.stringify(process.env.ADROUTER_E2E_BUILD === '1'),
  },
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/main/index.ts',
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    outDir: '.vite/build',
    rollupOptions: {
      external: [
        'electron',
        ...builtinModules,
        ...builtinModules.map((module) => `node:${module}`),
      ],
    },
  },
});
