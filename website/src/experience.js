import { gsap } from 'gsap';

export const examples = Object.freeze({
  update: {
    request: 'How’s the checkout fix going?',
    reply: 'The checkout session has a fix ready for review. Want a summary of the changes?',
    status: 'Update received. Your session kept its project context.',
    screen: 'Checkout fix',
  },
  voice: {
    request: 'Voice note: “Ask the API session for a quick update.”',
    reply: 'Your Mac transcribed the note. The API session reports that its changes are ready for your review.',
    status: 'Voice note → local transcript → your selected session.',
    screen: 'API cleanup',
  },
  scope: {
    request: 'Replying to Checkout fix: “Summarize your changes.”',
    reply: 'Checkout fix: I updated the validation and added a regression check. The other sessions were left alone.',
    status: 'Reply routed to one selected session. Your other work stays separate.',
    screen: 'One selected session',
  },
});

export function createExperience() {
  const abort = new AbortController();
  const listen = (node, event, fn) => node.addEventListener(event, fn, { signal: abort.signal });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const request = document.querySelector('[data-demo-request]');
  const reply = document.querySelector('[data-demo-reply]');
  const status = document.querySelector('[data-demo-status]');
  const send = document.querySelector('[data-send-demo]');
  const route = [...document.querySelectorAll('[data-route]')];
  const sceneSend = document.querySelector('[data-send-scene]');
  const sceneStatus = document.querySelector('[data-scene-status]');
  let sceneMessage;
  let selected = 'update';
  let timeline;
  let scene;
  let view = 'overview';
  let disposed = false;
  const setRoute = step => route.forEach((node, i) => node.classList.toggle('route-active', i <= step));
  const reset = () => {
    timeline?.kill();
    send.disabled = false;
    reply.closest('.demo-message').classList.remove('awaiting');
    setRoute(0);
  };
  document.querySelectorAll('[data-example]').forEach(button => listen(button, 'click', () => {
    reset();
    selected = button.dataset.example;
    document.querySelectorAll('[data-example]').forEach(node => node.setAttribute('aria-pressed', String(node === button)));
    request.textContent = examples[selected].request;
    reply.textContent = examples[selected].reply;
    status.textContent = 'Ready. Send this example to see the route.';
    scene?.setExample(examples[selected].screen);
  }));
  listen(send, 'click', () => {
    reset();
    const finish = () => {
      setRoute(2);
      reply.textContent = examples[selected].reply;
      reply.closest('.demo-message').classList.remove('awaiting');
      status.textContent = examples[selected].status;
      send.disabled = false;
    };
    if (reduced.matches) { finish(); return; }
    send.disabled = true;
    reply.closest('.demo-message').classList.add('awaiting');
    status.textContent = 'Your example message is on its way…';
    scene?.send();
    timeline = gsap.timeline()
      .call(() => { setRoute(1); status.textContent = 'Your master is coordinating the selected session…'; }, [], .5)
      .call(() => setRoute(2), [], 1.15)
      .call(finish, [], 1.8);
  });
  listen(sceneSend, 'click', () => {
    sceneMessage?.kill();
    scene?.send();
    sceneSend.disabled = true;
    sceneStatus.textContent = 'Sample message: phone → FarFromDesk → your session';
    const finish = () => {
      sceneStatus.textContent = 'Sample message delivered. Your workspace stays with you.';
      sceneSend.disabled = false;
    };
    if (reduced.matches) finish();
    else sceneMessage = gsap.delayedCall(1.8, finish);
  });
  document.querySelectorAll('[data-view]').forEach(button => listen(button, 'click', () => {
    view = button.dataset.view;
    document.querySelectorAll('[data-view]').forEach(node => node.setAttribute('aria-pressed', String(node === button)));
    scene?.setView(view);
  }));
  // Keep content and controls usable even when WebGL is unavailable.
  const viewport = document.querySelector('#scene-viewport');
  const loadButton = document.querySelector('[data-load-scene]');
  let loading = false;
  function loadScene() {
    if (loading || scene) return;
    loading = true;
    loadButton.disabled = true;
    loadButton.firstChild.textContent = 'Loading 3D… ';
    import('./scene.js').then(async ({ createScene }) => {
      await document.fonts.ready;
      if (disposed) return;
      scene = createScene(viewport, reduced);
      scene?.setView(view);
      scene?.setExample(examples[selected].screen);
      if (!scene) throw new Error('WebGL unavailable');
      viewport.closest('.hero-art').classList.add('interactive-ready');
      sceneSend.disabled = false;
    }).catch(() => {
      loadButton.hidden = true;
      document.querySelector('.scene-controls').hidden = true;
      sceneSend.hidden = true;
      sceneStatus.textContent = 'Static illustration · sample content. Try the message demo below.';
    });
  }
  listen(loadButton, 'click', loadScene);
  const loader = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    loader.disconnect();
    loadScene();
  }, { rootMargin: '100px' });
  // Mobile and reduced-motion visitors choose when to initialize the GPU.
  if (matchMedia('(min-width: 768px)').matches && !reduced.matches) loader.observe(viewport);
  listen(reduced, 'change', () => { reset(); scene?.setView(view); });
  return () => { disposed = true; abort.abort(); loader.disconnect(); timeline?.kill(); sceneMessage?.kill(); scene?.dispose(); };
}
