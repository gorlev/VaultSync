import { Engine } from '../src/engine.js';
import { stateFor } from '../src/state.js';
const s = await stateFor(process.argv[2], process.argv[3]);
await new Engine(s, { allowLocal: true, debounceMs: 0, afterFile: async () => process.kill(process.pid, 'SIGKILL') }).start();
