import test from 'node:test';
import assert from 'node:assert/strict';
import {jobsSpecialty} from '../src/jobs-agent.js';

test('the reusable Jobs specialty is fixed and leaves native permissions unchanged',()=>{
  const text=jobsSpecialty();
  assert.equal(jobsSpecialty(),text);
  assert.ok(Buffer.byteLength(text)<5000);
  assert.match(text,/existing selected session and its available research tools or skills/i);
  assert.match(text,/tool permissions and native approval requirements do not change/i);
  assert.match(text,/exact owner request and its approved task contract/i);
});

test('the specialty requires sourced facts and leaves unspecified eligibility and fit unknown',()=>{
  const text=jobsSpecialty();
  assert.match(text,/location, work authorization, sponsorship, experience level/i);
  assert.match(text,/offer an unspecified option/i);
  assert.match(text,/exact source link/i);
  assert.match(text,/missing, stale or conflicting details as unknown or unverified/i);
  assert.match(text,/actual resume and actual job description/i);
  assert.match(text,/if the owner has not provided supporting evidence, say fit is unknown/i);
  assert.match(text,/do not apply for a job, contact or message an employer/i);
  assert.match(text,/sign in, enter credentials, upload a resume, submit a form/i);
});
