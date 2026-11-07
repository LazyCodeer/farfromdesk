import test from 'node:test';import assert from 'node:assert/strict';import {formatPrs} from '../src/github-prs.js';
test('PR status lines say checks and review in plain words',()=>{
  const n=(state:string|null,review:string|null,isDraft=false)=>({number:7,title:'Fix it',url:'',repository:{nameWithOwner:'a/b'},reviewDecision:review,isDraft,commits:{nodes:[{commit:{statusCheckRollup:state?{state}:null}}]}});
  assert.equal(formatPrs([n('SUCCESS','REVIEW_REQUIRED'),n('FAILURE',null,true),n(null,'APPROVED')]),'b PR 7, Fix it: checks green, needs review\nb PR 7, Fix it: checks failing, draft\nb PR 7, Fix it: checks none, approved');
  assert.equal(formatPrs([{...n('FAILURE',null),url:'https://x/7',commits:{nodes:[{commit:{statusCheckRollup:{state:'FAILURE',contexts:{nodes:[{name:'lint',conclusion:'FAILURE'},{name:'test',conclusion:'SUCCESS'}]}}}}]}}]),'b PR 7, Fix it: checks failing (lint), no review needed https://x/7');
  assert.equal(formatPrs([]),'No open pull requests by the owner.');
});
