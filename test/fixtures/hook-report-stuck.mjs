// Never answers, like a config file on a disk that has gone to sleep. Test only.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readFileSync } = require('node:fs');
readFileSync(process.env.FFD_TEST_FIFO, 'utf8');
