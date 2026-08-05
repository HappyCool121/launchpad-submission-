import { cp, mkdir } from 'node:fs/promises';
await mkdir(new URL('../dist/lib/', import.meta.url), { recursive: true });
await cp(new URL('../src/lib/sponsors.json', import.meta.url), new URL('../dist/lib/sponsors.json', import.meta.url));
await mkdir(new URL('../dist/runtime/deepseek-tokenizer/', import.meta.url), { recursive: true });
await cp(new URL('../src/runtime/deepseek-tokenizer/tokenizer.json', import.meta.url), new URL('../dist/runtime/deepseek-tokenizer/tokenizer.json', import.meta.url));
await cp(new URL('../src/runtime/deepseek-tokenizer/tokenizer_config.json', import.meta.url), new URL('../dist/runtime/deepseek-tokenizer/tokenizer_config.json', import.meta.url));
