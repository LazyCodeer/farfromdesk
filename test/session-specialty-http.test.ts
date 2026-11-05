import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import { reservePort } from './test-port.js';

const root=mkdtempSync(join(tmpdir(),'ffd-specialty-http-'));
const port=await reservePort();
process.env.WSB_STATE_DIR=root;process.env.WSB_PORT=String(port);process.env.CODEX_HOME=join(root,'codex');process.env.CLAUDE_CONFIG_DIR=join(root,'claude');
const [{serve},{Store},{Router},{Approvals},{MetaSecret,DEFAULT_BRAIN,saveBrainConfig},{TaskContracts},{ensureFfd,runFfd},{turnEnvelope}]=await Promise.all([import('../src/server.js'),import('../src/store.js'),import('../src/router.js'),import('../src/approvals.js'),import('../src/meta-brain-config.js'),import('../src/task-contracts.js'),import('../src/ffd.js'),import('../src/roles.js')]);
