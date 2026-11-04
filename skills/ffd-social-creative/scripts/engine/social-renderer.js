import { vectorSceneSchema } from './social-vector.js';
import { renderSocialScene, socialIllustrations } from './social-scene.js';
import { z } from 'zod';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { safeSocialJpeg } from './social-jpeg.js';
const copy = (max) => z.string().trim().min(1).max(max).refine(s => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), 'Unsupported control character');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Visual = z.object({ kind: z.enum(['hub', 'flow']), labels: z.array(copy(28)).min(2).max(5), center: copy(28).optional() }).strict();
const Slide = z.object({ visual: Visual.optional(), layout: z.enum(['cover', 'statement', 'bullets', 'steps', 'conversation', 'illustration']), headline: copy(100), illustration: z.enum(socialIllustrations).optional(), drawing: vectorSceneSchema.optional(), tone: z.enum(['dark', 'light']).optional(), footer: copy(100).optional(), eyebrow: copy(40).optional(), body: copy(180).optional(), points: z.array(copy(90)).min(1).max(4).optional(), artwork: z.boolean().default(false) }).strict();
const Plan = z.object({ mode: z.enum(['svg', 'hybrid']), brand: z.object({ name: copy(40), logo: z.literal('spliceai').optional(), accent: color, background: color, foreground: color }).strict(), slides: z.array(Slide).min(1).max(8) }).strict();
export const socialRenderPlanSchema = z.toJSONSchema(Plan);
export function parseSocialPlan(input) {
    const p = Plan.parse(input);
    if (p.mode === 'svg' && p.slides.some(s => s.artwork) || p.mode === 'hybrid' && !p.slides.some(s => s.artwork))
        throw Error('SVG has no artwork; hybrid needs at least one artwork slide.');
    if (p.slides.some(s => ['bullets', 'steps', 'conversation'].includes(s.layout) && !s.points?.length))
        throw Error('This layout needs points.');
    if (p.slides.some(s => s.visual && (s.points?.length || s.artwork) || s.artwork && s.points?.length))
        throw Error('Choose one visual treatment per slide: diagram, points or artwork.');
    if (p.brand.logo === 'spliceai' && !/^splice\s*ai$/i.test(p.brand.name))
        throw Error('The Splice AI logo is only for Splice AI.');
    if (p.slides.some(s => s.layout === 'illustration' ? (!s.illustration && !s.drawing) || !!s.illustration && !!s.drawing || s.artwork || !!s.visual || !!s.points : s.illustration !== undefined || s.drawing !== undefined || s.tone !== undefined || s.footer !== undefined))
        throw Error('Illustration layout requires one bundled illustration and no other artwork treatment.');
    return p;
}
const fontfile = fileURLToPath(new URL('../../assets/Onest-Regular.ttf', import.meta.url));
const boldfile = fileURLToPath(new URL('../../assets/Onest-Bold.ttf', import.meta.url));
const escape = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const hash = (b) => createHash('sha256').update(b).digest('hex');
const rectangle = (x, y, w, h, fill, r = 0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
const luminance = (hex) => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
/** Structured primitives only. No model SVG, remote URLs, paths or executable markup. */
export async function renderSocialPlan(input, artwork) {
    const p = parseSocialPlan(input);
    if (contrast(p.brand.background, p.brand.foreground) < 4.5)
        throw Error('Brand foreground and background need stronger contrast (at least 4.5:1).');
    if (p.mode === 'hybrid' && (!artwork || !safeSocialJpeg(artwork)))
        throw Error('Generate and save artwork on this draft before hybrid rendering, or use SVG.');
    const results = [];
    for (const [index, s] of p.slides.entries()) {
        if (s.layout === 'illustration') {
            results.push(await renderSocialScene(p.brand, { ...s, illustration: s.illustration }, index, p.slides.length));
            continue;
        }
        const dark = s.layout === 'cover' || s.layout === 'statement' || s.artwork;
        const bg = dark ? p.brand.background : p.brand.foreground, fg = dark ? p.brand.foreground : p.brand.background;
        const accentText = contrast(p.brand.accent, bg) >= 3 ? p.brand.accent : fg;
        const onAccent = contrast(p.brand.accent, p.brand.background) > contrast(p.brand.accent, p.brand.foreground) ? p.brand.background : p.brand.foreground;
        const card = dark ? '#1D292F' : '#FFFFFF';
        const cardInk = contrast(card, fg) >= 4.5 ? fg : (dark ? '#FFFFFF' : '#152027');
        const text = [], media = [];
        let shapes = rectangle(0, 0, 1080, 1350, bg);
        const put = async (value, x, y, width, height, size, fill = fg, bold = false) => {
            for (let f = size; f >= Math.max(24, size - 20); f -= 2) {
                const output = await sharp({ text: { text: `<span foreground="${fill}">${escape(value)}</span>`, font: `Onest ${bold ? 'Bold ' : ''}${f}`, fontfile: bold ? boldfile : fontfile, width, rgba: true, wrap: 'word', spacing: 2 } }).png().toBuffer({ resolveWithObject: true });
                if (output.info.height <= height && output.info.width <= width) {
                    text.push({ input: output.data, left: Math.round(x), top: Math.round(y) });
                    return output.info.height;
                }
            }
            throw Error(`Slide ${index + 1} has text that does not fit. Shorten or split it.`);
        };
        await put(p.brand.name, 68, 55, 780, 45, 26, fg, true);
        await put(`${String(index + 1).padStart(2, '0')} / ${String(p.slides.length).padStart(2, '0')}`, 913, 58, 105, 40, 24);
        shapes += rectangle(68, 117, 944, 2, fg) + rectangle(68, 117, Math.round(944 * (index + 1) / p.slides.length), 4, p.brand.accent);
        if (s.eyebrow)
            await put(s.eyebrow.toUpperCase(), 68, 162, 930, 55, 24, accentText, true);
        const editorial = !s.artwork && !s.visual && !s.points && !(s.layout === 'cover' && p.slides.length > 1);
        const headlineY = editorial ? 300 : (s.eyebrow ? 229 : 177);
        const hh = await put(s.headline, 64, headlineY, 952, editorial ? 650 : 330, editorial ? 138 : s.layout === 'cover' ? 104 : 88, fg, true);
        let next = headlineY + hh + 32;
        if (s.body) {
            const h = await put(s.body, 68, next, 902, Math.min(160, 1194 - next), 34);
            next += h + 38;
        }
        const start = Math.max(next, 560), bottom = 1194;
        if (!editorial && start > 850)
            throw Error(`Slide ${index + 1} has too much introductory copy. Shorten the headline or body.`);
        if (s.artwork) {
            const height = bottom - start;
            const photo = await sharp(artwork, { limitInputPixels: 16_777_216 }).resize(944, height, { fit: 'cover' }).png().toBuffer();
            const mask = Buffer.from(`<svg width="944" height="${height}">${rectangle(0, 0, 944, height, '#FFFFFF', 28)}</svg>`);
            const clipped = await sharp(photo).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
            media.push({ input: clipped, left: 68, top: start });
        }
        else if (s.visual) {
            const v = s.visual;
            if (v.kind === 'hub') {
                if (bottom - start < 480)
                    throw Error(`Slide ${index + 1} needs more space for its diagram. Shorten the headline or body.`);
                const cy = start + (bottom - start) / 2, cx = 540;
                const coords = v.labels.length <= 3 ? [[68, start], [704, start], [386, bottom - 114]] : [[68, start], [704, start], [68, bottom - 114], [704, bottom - 114], [386, bottom - 114]];
                // For five labels the bottom centre joins two lower corner nodes.
                for (let j = 0; j < v.labels.length; j++) {
                    const [x, y] = coords[j];
                    shapes += `<path d="M ${x + 154} ${y + 57} Q 540 ${y + 57} ${cx} ${cy}" fill="none" stroke="${p.brand.accent}" stroke-opacity=".5" stroke-width="3"/>`;
                }
                shapes += `<circle cx="540" cy="${cy}" r="133" fill="none" stroke="${p.brand.accent}" stroke-opacity=".16" stroke-width="2"/>`;
                shapes += rectangle(386, cy - 72, 308, 144, p.brand.accent, 32);
                await put(v.center ?? p.brand.name, 416, cy - 26, 248, 98, 36, onAccent, true);
                for (let j = 0; j < v.labels.length; j++) {
                    const [x, y] = coords[j];
                    shapes += rectangle(x, y, 308, 114, card, 22);
                    shapes += rectangle(x + 22, y + 22, 5, 70, p.brand.accent, 2);
                    await put(v.labels[j], x + 43, y + 34, 244, 70, 30, cardInk, true);
                }
            }
            else {
                const h = (bottom - start - 18 * (v.labels.length - 1)) / v.labels.length;
                for (let j = 0; j < v.labels.length; j++) {
                    const y = start + j * (h + 18);
                    shapes += rectangle(68, y, 944, h, card, 24) + rectangle(90, y + 18, 64, Math.min(64, h - 30), p.brand.accent, 16);
                    await put(String(j + 1).padStart(2, '0'), 104, y + 30, 58, 46, 28, onAccent, true);
                    await put(v.labels[j], 180, y + 30, 785, h - 38, 36, cardInk, true);
                }
            }
        }
        else if (s.points) {
            const n = s.points.length, available = bottom - start;
            if (s.layout === 'conversation') {
                const h = Math.min(158, (available - (n - 1) * 22) / n);
                for (const [j, point] of s.points.entries()) {
                    const x = j % 2 ? 192 : 68, y = start + j * (h + 22), w = 820;
                    shapes += rectangle(x, y, w, h, j % 2 ? p.brand.accent : card, 26);
                    await put(point, x + 30, y + 28, w - 60, h - 48, 36, j % 2 ? onAccent : cardInk);
                }
            }
            else {
                const h = (available - 18 * (n - 1)) / n;
                for (const [j, point] of s.points.entries()) {
                    const y = start + j * (h + 18);
                    shapes += rectangle(68, y, 944, h, card, 22);
                    await put(String(j + 1).padStart(2, '0'), 94, y + 24, 94, 74, 42, contrast(p.brand.accent, card) >= 3 ? p.brand.accent : cardInk, true);
                    await put(point, 214, y + 26, 756, h - 44, 36, cardInk, true);
                }
            }
        }
        else if (s.layout === 'cover' && p.slides.length > 1) {
            const previews = p.slides.slice(1, 4), h = (bottom - start - 18 * (previews.length - 1)) / previews.length;
            for (const [j, item] of previews.entries()) {
                const y = start + j * (h + 18);
                shapes += rectangle(68, y, 944, h, card, 22);
                await put(String(j + 2).padStart(2, '0'), 96, y + 25, 88, 70, 40, contrast(p.brand.accent, card) >= 3 ? p.brand.accent : cardInk, true);
                await put(item.headline, 210, y + 27, 756, h - 48, 36, cardInk, true);
            }
        }
        shapes += rectangle(68, 1251, 944, 1, fg);
        await put(p.brand.name, 68, 1280, 780, 40, 24);
        const footer = p.slides.length === 1 ? '' : index < p.slides.length - 1 ? 'SWIPE TO CONTINUE' : 'SAVE THIS GUIDE';
        if (footer)
            await put(footer, 696, 1280, 316, 40, 24, fg, true);
        const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">${shapes}</svg>`);
        const bytes = await sharp(background).composite([...media, ...text]).jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toBuffer();
        if (bytes.length > 2_000_000)
            throw Error('Rendered slide is too large.');
        const thumbnail = await sharp(bytes).resize(360, 450).jpeg({ quality: 85, chromaSubsampling: '4:4:4' }).toBuffer();
        results.push({ base64: bytes.toString('base64'), thumbnail: thumbnail.toString('base64'), sha256: hash(bytes), alt: [s.headline, s.body, ...s.points ?? [], ...s.visual?.labels ?? []].filter(Boolean).join(' ') });
    }
    return results;
}
