/**
 * Hypothetical, test-only protocol. The proof flags and invocation IDs below
 * are NOT supplied by the documented Claude Desktop interfaces. This module
 * must never be imported by production code or used to authorize a handoff.
 */
export type LifecycleFixture = {
  expected:{session:string;request:string;attempt:string;envelopeHash:string;owner:string;destination:string;contractHash:string;revision:number;bindingFingerprint:string;claimGeneration:number};
  current:{session:string;request:string;attempt:string;owner:string;destination:string;contractHash:string;revision:number;bindingFingerprint:string;claimGeneration:number};
  prompt:{session:string;promptId:string;envelopeHash:string;originProof:boolean};
  stop:{session:string;promptId:string;invocation:string;backgroundTasks:string[]|null;sessionCrons:string[]|null};
  telemetry:{session:string;promptId:string;invocation:string;blocking:number;cancelled:number;nonBlockingErrors:number;additionalContextChars:number;persistedOutputs:number}|null;
  // These are explicit hypothetical assumptions, not observations available
  // from the current transport or asynchronous telemetry.
  orderedCompleteStream:boolean;
  exclusiveProviderFence:boolean;
  uniquePromptMapping:boolean;
  interrupted:boolean;
};

export function hypotheticalHandoffPermitted(f:LifecycleFixture):boolean {
  const {expected:e,current:c,prompt:p,stop:s,telemetry:t}=f;
  if(c.session!==e.session||c.request!==e.request||c.attempt!==e.attempt||c.owner!==e.owner||
    c.destination!==e.destination||c.contractHash!==e.contractHash||c.revision!==e.revision||c.bindingFingerprint!==e.bindingFingerprint||c.claimGeneration!==e.claimGeneration||
    p.session!==e.session||p.envelopeHash!==e.envelopeHash||!p.promptId||!p.originProof||
    s.session!==e.session||s.promptId!==p.promptId||!s.invocation||
    !Array.isArray(s.backgroundTasks)||s.backgroundTasks.length||!Array.isArray(s.sessionCrons)||s.sessionCrons.length||
    !t||t.session!==e.session||t.promptId!==p.promptId||t.invocation!==s.invocation||
    t.blocking!==0||t.cancelled!==0||t.nonBlockingErrors!==0||t.additionalContextChars!==0||t.persistedOutputs!==0||
    !f.orderedCompleteStream||!f.exclusiveProviderFence||!f.uniquePromptMapping||f.interrupted)return false;
  return true;
}
