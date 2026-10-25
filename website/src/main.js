import { createMotion } from './motion.js';
import { createExperience } from './experience.js';
const destroyExperience = createExperience();

const abort = new AbortController();
const listen = (node, type, fn) => node.addEventListener(type, fn, {signal:abort.signal});
const motion = createMotion();
const menuButton = document.querySelector('.menu-toggle');
const mobileNav = document.querySelector('#mobile-nav');
function setMenu(open) {
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  mobileNav.hidden = !open;
}
listen(menuButton, 'click', () => setMenu(mobileNav.hidden));
listen(document, 'keydown', event => {
  if (event.key === 'Escape' && !mobileNav.hidden) { setMenu(false); menuButton.focus(); }
});
listen(document, 'click', event => {
  if (!mobileNav.hidden && !event.target.closest('.site-header')) setMenu(false);
});
mobileNav.querySelectorAll('a').forEach(link => listen(link, 'click', () => setMenu(false)));

const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(index, focus = false) {
  tabs.forEach((tab, i) => {
    const active = i === index;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    panel.hidden = !active;
    if (active) motion.panel(panel);
  });
  if (focus) tabs[index].focus();
}
tabs.forEach((tab, index) => {
  listen(tab, 'click', () => selectTab(index));
  listen(tab, 'keydown', event => {
    const key = event.key;
    if (!['ArrowDown','ArrowUp','Home','End'].includes(key)) return;
    event.preventDefault();
    const next = key === 'Home' ? 0 : key === 'End' ? tabs.length - 1 : (index + (key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(next, true);
  });
});

const privacy = document.querySelector('#website-privacy');
listen(document.querySelector('[data-site-privacy]'), 'click', () => privacy.showModal());
document.querySelectorAll('[data-close-privacy]').forEach(button => listen(button, 'click', () => privacy.close()));
listen(privacy, 'click', event => {
  const bounds = privacy.getBoundingClientRect();
  if (event.target === privacy && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) privacy.close();
});
document.querySelectorAll('details').forEach(details => listen(details, 'toggle', motion.refresh));

const responsiveNav = window.matchMedia('(min-width: 768px)');
listen(responsiveNav, 'change', event => { if (event.matches) setMenu(false); });

// Fast back/forward navigation preserves the page; HMR fully tears down listeners.
if (import.meta.hot) import.meta.hot.dispose(() => { abort.abort(); motion.destroy(); destroyExperience(); });
