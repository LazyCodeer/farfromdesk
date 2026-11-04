import test from 'node:test';
import assert from 'node:assert/strict';
import {asksForSocialCreation} from '../src/social-intent.js';
test('conservative Social intent recognizes creation and leaves code, negations and quoted instructions alone',()=>{
 for(const text of ['Create a post','Can you generate an Instagram carousel?','Please make social content about cart recovery','Draft LinkedIn copy','post on Facebook about our launch'])assert.equal(asksForSocialCreation(text),true,text);
 for(const text of ['Do not create a post',"Don’t generate posts",'Never write a post','Fix the POST endpoint','Create a blog post','/social','> create posts','What happened to my last post?'])assert.equal(asksForSocialCreation(text),false,text);
});
