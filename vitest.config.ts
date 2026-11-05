import { defineConfig } from 'vitest/config';

/**
 * Vitest config — unit tests for the pure modules (tests/). The production
 * esbuild pipeline (build.mjs) is ARCHITECT-owned and does not read this
 * file. environment 'node' is deliberate: src/shared/noise.ts and its sibling
 * pure modules are DOM-free by design (TECHNICAL-BRIEF §6 — the noise.ts /
 * hooks.ts split is mandatory for gate 8.2).
 *
 * Source files import each other with '.js' specifiers that point at sibling
 * '.ts' files (tsconfig moduleResolution: Bundler; esbuild resolves the same
 * mapping at bundle time). Mirror that mapping here so the test runner
 * resolves exactly what the build resolves.
 */
export default defineConfig({
  plugins: [
    {
      name: 'canvcdc5-ts-js-extension-alias',
      enforce: 'pre',
      resolveId(
        this: { resolve(s: string, i: string, o: { skipSelf: boolean }): Promise<unknown> },
        source: string,
        importer: string | undefined,
      ) {
        if (!importer || !source.endsWith('.js')) return null;
        if (!source.startsWith('./') && !source.startsWith('../')) return null;
        return this.resolve(source.slice(0, -3) + '.ts', importer, { skipSelf: true });
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
