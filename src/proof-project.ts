import type {Router} from './router.js';

/**
 * Disabled until a bridge-owned lifecycle boundary and an immutable,
 * read-contained repository observation can be established. A pathname can
 * be swapped and restored between Git operations; inode checks do not make
 * the reads atomic. Git configuration and index flags also prevent status
 * output from proving the workspace contents. Never use prior prototype
 * records as proof.
 */
export class ProofProjectSnapshots {
  constructor(_router:Router) {}
  async capture(_id:string,_phase:'before'|'after'):Promise<boolean>{
    return false;
  }
}
