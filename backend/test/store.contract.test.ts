/** Runs the single contract suite against BOTH implementations (NFR-03, 13 §2). */

import { MemoryHubStore } from '../src/store/memory.js';
import { SqliteHubStore } from '../src/store/sqlite.js';
import { storeContractSuite } from './storeContract.js';

storeContractSuite('sqlite (:memory:)', () => new SqliteHubStore(':memory:'));
storeContractSuite('in-memory fake', () => new MemoryHubStore());
