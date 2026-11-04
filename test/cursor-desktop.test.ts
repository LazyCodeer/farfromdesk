import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  cursorPromptUrl,
  cursorSessions,
  cursorUserText,
  readBounded,
  readCursorTranscript,
  runCursorTurn,
  findCursorCli,
} from '../src/cursor-desktop.js';
import {cursorConversationDb,cursorProjectSlug} from '../src/cursor-paths.js';

const realTmp=realpathSync(tmpdir());
const dirs:string[]=[];
function fixture(prefix:string):string {
  const dir=mkdtempSync(join(realTmp,prefix));
  dirs.push(dir);
  return dir;
}
test.after(()=>{for(const dir of dirs)rmSync(dir,{recursive:true,force:true});});

/** One synthetic Cursor transcript: the owner's wrapped prompt, a tool call, an answer, and an end. */
function transcript(prompt:string,answer:string,complete=true):string {
  const lines=[
    JSON.stringify({type:'message',role:'user',message:{content:[{type:'text',text:`<timestamp>2026-01-01T00:00:00Z</timestamp>\n<user_query>${prompt}</user_query>`}]}}),
    JSON.stringify({type:'message',role:'assistant',message:{content:[{type:'tool_use',name:'read_file',input:{path:'x.ts'}}]}}),
    JSON.stringify({type:'message',role:'assistant',message:{content:[{type:'text',text:answer}]}}),
  ];
  if(complete)lines.push(JSON.stringify({type:'turn_ended'}));
  return `${lines.join('\n')}\n`;
}

function writeTranscript(chatId:string,body:string,env:NodeJS.ProcessEnv,project='demo'):string {
  const root=join(env.CURSOR_DATA_DIR!,'projects',project,'agent-transcripts',chatId);
  mkdirSync(root,{recursive:true});
  const file=join(root,`${chatId}.jsonl`);
  writeFileSync(file,body);
  return file;
}

test('the deeplink encodes the prompt as %20 and carries optional workspace and mode',()=>{
  const bare=cursorPromptUrl('fix the parser');
  assert.match(bare,/^cursor:\/\/anysphere\.cursor-deeplink\/prompt\?/);
  assert.match(bare,/text=fix%20the%20parser/);
  assert.doesNotMatch(bare,/%2B/);
  const routed=cursorPromptUrl('go',{workspace:'My App',mode:'agent'});
  assert.match(routed,/workspace=My%20App/);
  assert.match(routed,/mode=agent/);
});

test('a transcript keeps text and tool names and only turn_ended proves it finished',()=>{
  const base=fixture('cursor-desktop-parse-'),env={CURSOR_DATA_DIR:base} as NodeJS.ProcessEnv;
  const file=writeTranscript('chat-1',transcript('run the tests','All tests pass.'),env);
  const parsed=readCursorTranscript(file);
  assert.equal(parsed.complete,true);
  assert.deepEqual(parsed.messages.map((m)=>m.role),['user','assistant','assistant']);
  assert.deepEqual(parsed.messages[1]!.tools,['read_file']);
  assert.match(parsed.messages[2]!.text,/All tests pass/);
  const unfinished=readCursorTranscript(writeTranscript('chat-2',transcript('later','not yet',false),env));
  assert.equal(unfinished.complete,false);
});

test('cursorUserText unwraps the user_query and drops the timestamp',()=>{
  assert.equal(cursorUserText('<timestamp>2026-01-01</timestamp><user_query>  fix the\n parser  </user_query>'),'fix the parser');
  assert.equal(cursorUserText('plain owner text'),'plain owner text');
});

test('a bounded read keeps whole JSON lines and never throws on a missing file',()=>{
  const base=fixture('cursor-desktop-bounds-');
  const file=join(base,'lines.jsonl');
  writeFileSync(file,`${'a'.repeat(40)}\n${'b'.repeat(40)}\n`);
  assert.equal(readBounded(join(base,'missing.jsonl'),10),'');
  assert.equal(readBounded(file,1000),`${'a'.repeat(40)}\n${'b'.repeat(40)}\n`);
  assert.doesNotMatch(readBounded(file,10,'tail'),/^\n/);
});

test('the catalog reads chat titles from the search DB and recovers the project folder',()=>{
  const base=fixture('cursor-desktop-catalog-'),env={CURSOR_DATA_DIR:base,CURSOR_SUPPORT_DIR:join(base,'support')} as NodeJS.ProcessEnv;
  const workspace=join(base,'workspace-demo');
  mkdirSync(workspace,{recursive:true});
  const slug=cursorProjectSlug(workspace);
  const file=join(base,'projects',slug,'agent-transcripts','chat-9','chat-9.jsonl');
  mkdirSync(join(base,'projects',slug,'agent-transcripts','chat-9'),{recursive:true});
  writeFileSync(file,transcript('hello','Hi there.'));
  // Subagent transcripts live one level deeper and must never appear as an owner-selectable chat.
  const nested=join(base,'projects',slug,'agent-transcripts','chat-9','subagent','deep.jsonl');
  mkdirSync(join(base,'projects',slug,'agent-transcripts','chat-9','subagent'),{recursive:true});
  writeFileSync(nested,transcript('hidden','hidden'));
  const dbFile=cursorConversationDb(env);
  mkdirSync(join(dbFile,'..'),{recursive:true});
  const db=new DatabaseSync(dbFile);
  db.exec('CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT)');
  db.prepare('INSERT INTO conversations(id,title) VALUES(?,?)').run('chat-9','Fix the parser');
  db.close();
  const sessions=cursorSessions(env);
  assert.equal(sessions.length,1);
  assert.equal(sessions[0]!.id,'chat-9');
  assert.equal(sessions[0]!.provider,'cursor');
  assert.equal(sessions[0]!.executionMode,'cli');
  assert.equal(sessions[0]!.name,'Fix the parser');
  assert.equal(sessions[0]!.cwd,workspace);
});

// runCursorTurn is a prefill hand-off, not autonomous delivery: the deeplink only reaches a Cursor
// window that is already open. The fake `open` below stands in for that open window acting on the
// prefill and writing the turn to a transcript.
test('runCursorTurn waits for turn_ended and returns the chat id',async()=>{
  const base=fixture('cursor-desktop-turn-'),env={CURSOR_DATA_DIR:base} as NodeJS.ProcessEnv;
  const result=await runCursorTurn({
    prompt:'run the tests',
    env,
    timeoutMs:2000,
    pollMs:10,
    open:async(url)=>{
      assert.match(url,/text=run%20the%20tests/);
      writeTranscript('chat-live',transcript('run the tests','All tests pass.'),env);
    },
  });
  assert.equal(result.text,'All tests pass.');
  assert.equal(result.sessionId,'chat-live');
});

test('runCursorTurn matches a multi-line prompt after Cursor collapses its whitespace',async()=>{
  const base=fixture('cursor-desktop-collapse-'),env={CURSOR_DATA_DIR:base} as NodeJS.ProcessEnv;
  // Cursor stores the owner's message with whitespace collapsed, so the outgoing multi-line prompt
  // must be normalised before it is matched back; otherwise this turn would never be found.
  const result=await runCursorTurn({
    prompt:'fix the\n  parser  tests',
    env,
    timeoutMs:2000,
    pollMs:10,
    open:async()=>{writeTranscript('chat-collapsed',transcript('fix the parser tests','Fixed.'),env);},
  });
  assert.equal(result.text,'Fixed.');
  assert.equal(result.sessionId,'chat-collapsed');
});

test('runCursorTurn refuses an unfinished turn instead of reporting a silent answer',async()=>{
  const base=fixture('cursor-desktop-timeout-'),env={CURSOR_DATA_DIR:base} as NodeJS.ProcessEnv;
  // The prefill nobody picked up: no window acted on it, so nothing lands in a transcript. The timeout
  // is what keeps that visible - an unpicked delivery must never come back as an answer.
  await assert.rejects(
    runCursorTurn({prompt:'never finishes',env,timeoutMs:80,pollMs:10,open:async()=>{}}),
    /did not finish this turn in time/,
  );
});
test('runCursorTurn reports a prompt Cursor never took within the pickup window, not after the full timeout',async()=>{
  const base=fixture('cursor-desktop-pickup-'),env={CURSOR_DATA_DIR:base} as NodeJS.ProcessEnv;
  const started=Date.now();
  await assert.rejects(
    runCursorTurn({prompt:'nobody takes this',env,timeoutMs:5000,pickupMs:60,pollMs:10,open:async()=>{}}),
    /did not take the message/,
  );
  assert.ok(Date.now()-started<2000);
});

test('runCursorTurn runs a signed-in cursor-agent by command and returns its answer and chat id',async()=>{
  const base=fixture('cursor-desktop-cli-');
  const bin=join(base,'cursor-agent');
  writeFileSync(bin,`#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]!=='status'&&!a.includes('--force'))process.exit(3);if(a[0]==='status'){console.log('Logged in as owner');process.exit(0);}\nfor(const e of [{type:'assistant',message:{content:[{type:'text',text:'Checking first.'}]}},{type:'tool_call',subtype:'completed'},{type:'assistant',message:{content:[{type:'text',text:'Hi from the CLI: '+a.at(-1)}]}},{type:'result',is_error:false,result:'Checking first.Hi from the CLI: '+a.at(-1),session_id:'cli-chat-1'}])console.log(JSON.stringify(e));\n`);
  chmodSync(bin,0o755);
  const env={CURSOR_DATA_DIR:base,CURSOR_AGENT_BIN:bin} as NodeJS.ProcessEnv;
  const cli=findCursorCli(env);
  assert.equal(cli,bin);
  const result=await runCursorTurn({prompt:'say hi',env,cli,cwd:base,open:async()=>{throw new Error('the app must not be used');}});
  assert.equal(result.text,'Hi from the CLI: say hi');
  assert.equal(result.sessionId,'cli-chat-1');
});
