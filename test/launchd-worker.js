// Validation-only entry point. Production CLI intentionally has no local-remote bypass.
import { Engine } from '../src/engine.js';
import { stateFor } from '../src/state.js';
const s = await stateFor(process.argv[process.argv.indexOf('--vault') + 1]);
const engine = await new Engine(s, { allowLocal: true }).start();
process.on('SIGTERM', () => engine.stop()); process.on('SIGINT', () => engine.stop());
