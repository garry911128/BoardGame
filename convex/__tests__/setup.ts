// edge-runtime doesn't define Node's `process`; the engine's debug.ts reads
// process.env.DEBUG_GAME. Convex's real runtime provides process.env, so this
// only bridges the test environment gap.
const g = globalThis as any;
if (typeof g.process === 'undefined') g.process = { env: { DEBUG_GAME: '0' } };
else if (typeof g.process.env === 'undefined') g.process.env = { DEBUG_GAME: '0' };
