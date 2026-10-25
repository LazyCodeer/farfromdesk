import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
gsap.registerPlugin(ScrollTrigger);

// Adapted from Codecy Labs createMotion: all animation lives inside a
// revertible matchMedia context. Native scroll and static content remain intact.
export function createMotion() {
  const media = gsap.matchMedia();
  let messages;
  let panelContext;
  media.add('(prefers-reduced-motion: no-preference)', () => {
    gsap.timeline({defaults:{ease:'power3.out'}})
      .from('.hero-copy h1', {y:24,duration:.9})
      .from('.hero-description, .hero-actions', {y:16,duration:.75,stagger:.1},'-.6')
      .from('.hero-art', {y:25,duration:.95},'-.7');
    gsap.utils.toArray('.section-heading h2, .coord-heading h2, .voice-copy h2, .privacy-section h2, .faq h2, .release-copy h2, .demo-intro h2').forEach(element => {
      gsap.from(element,{y:24,duration:.75,ease:'power3.out',scrollTrigger:{trigger:element,start:'top 92%',once:true}});
    });
    gsap.from('.flow-origin, .flow-master, .flow-workers>div', {y:15,opacity:0,duration:.65,stagger:.12,scrollTrigger:{trigger:'.flow-map',start:'top 85%',once:true}});
    // The waveform responds once as the voice example enters the viewport.
    gsap.from('.waveform i',{scaleY:.3,transformOrigin:'center',duration:.65,stagger:.017,ease:'power2.out',scrollTrigger:{trigger:'.voice-art',start:'top 83%',once:true}});
    return () => { messages = null; };
  });
  return {
    replay: () => messages?.restart(),
    refresh: () => ScrollTrigger.refresh(),
    panel: element => {
      panelContext?.revert();
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      // Temporary context is reverted after the brief transition finishes.
      panelContext = gsap.context(() => gsap.from(element.children, {opacity:0,y:8,duration:.35,stagger:.03}));
    },
    destroy: () => { panelContext?.revert(); media.revert(); },
  };
}
