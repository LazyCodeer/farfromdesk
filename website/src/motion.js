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
      .from('.hero-copy h1', {y:25,duration:.85})
      .from('.hero-description, .hero-actions', {y:16,duration:.7,stagger:.1},'-.6')
      .from('.mac-illustration', {y:25,opacity:0,duration:1},'-.65')
      .from('.phone-illustration', {y:35,opacity:0,duration:.9},'-.65');
    messages = gsap.timeline({delay:1.15,defaults:{ease:'power2.out'}})
      .from('.bubble.sent:not(.bubble-last)', {opacity:0,y:8,duration:.45})
      .from('.bubble.received', {opacity:0,y:8,duration:.45},'+=.4')
      .from('.bubble-last', {opacity:0,y:8,duration:.45},'+=.4');
    gsap.utils.toArray('.section-heading h2, .coord-heading h2, .voice-copy h2, .privacy-section h2, .faq h2, .release-copy h2').forEach(element => {
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
