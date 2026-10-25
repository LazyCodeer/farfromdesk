# Design decisions

Reading: developer product launch, editorial dark layout, indigo accent, purposeful explanatory motion. Design variance 7 / motion intensity 6 / visual density 4.

## Inherited foundation

Codecy Labs' actual Vite/vanilla JS stack, self-hosted font trio, split hero, typography rhythm, circular-arrow buttons, native FAQ disclosure and GSAP matchMedia/cleanup pattern. No React conversion, contact backend, studio analytics or unrelated company assets.

## Product expression

Canvas `#17181D`, panels `#202126`, indigo text/action surfaces, pale text. Palette anchored to current native `BridgeStyle`, with a lighter accent for website contrast. The explicit brief calls for dark appearance. Layout families: split hero, horizontal overview, interactive walkthrough, central flow diagram, voice editorial split, compatibility rows, privacy list, FAQ and release block.

Illustrations deliberately use sample data. They explain capabilities and do not purport to be live app views. The QR icon cannot pair a device. No external generated media or user recordings are used.

## Motion and accessibility

Initial hero movement establishes hierarchy. Request/reply bubbles show message order once and offer Replay. Setup changes get a short transition. The coordination graph and voice waveform reveal once in reading order. No infinite animation, custom cursor, scroll hijacking or persistent WebGL renderer.

OS reduced motion removes automatic animation and smooth scrolling. Native controls retain keyboard focus. Tab-panel relationships, arrow navigation, modal Escape and mobile navigation are explicit. Header layer 3, skip link layer 5; the native dialog uses the top layer.
