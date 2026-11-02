import { z } from 'zod';
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const paint = z.union([color, z.literal('none'), z.string().regex(/^url\(#g[0-9]{1,2}\)$/)]);
const n = z.number().finite().min(-3000).max(3000);
const path = z.string().min(1).max(6000).regex(/^[MmLlHhVvCcSsQqTtAaZz0-9.,+\s-]+$/).refine(s => [...s.matchAll(/[-+]?(?:\d*\.)?\d+/g)].every(m => Math.abs(Number(m[0])) <= 3000), 'Path coordinates exceed bounds');
const common = { fill: paint.default('none'), stroke: paint.default('none'), strokeWidth: z.number().min(0).max(24).default(0), opacity: z.number().min(0).max(1).default(1) };
const shape = z.discriminatedUnion('type', [
    z.object({ type: z.literal('path'), d: path, ...common }).strict(),
    z.object({ type: z.literal('rect'), x: n, y: n, width: z.number().min(1).max(2000), height: z.number().min(1).max(2000), radius: z.number().min(0).max(500).default(0), ...common }).strict(),
    z.object({ type: z.literal('ellipse'), cx: n, cy: n, rx: z.number().min(1).max(1500), ry: z.number().min(1).max(1500), ...common }).strict(),
]);
export const vectorSceneSchema = z.object({
    gradients: z.array(z.object({ id: z.string().regex(/^g[0-9]{1,2}$/), x1: z.number().min(0).max(1), y1: z.number().min(0).max(1), x2: z.number().min(0).max(1), y2: z.number().min(0).max(1), stops: z.array(z.object({ offset: z.number().min(0).max(1), color }).strict()).min(2).max(8) }).strict()).max(16).default([]),
    shapes: z.array(shape).min(1).max(220),
}).strict().superRefine((v, c) => {
    const ids = new Set(v.gradients.map(g => g.id));
    if (ids.size !== v.gradients.length)
        c.addIssue({ code: 'custom', message: 'Gradient IDs must be unique' });
    for (const g of v.gradients)
        if (g.stops.some((s, i) => i > 0 && s.offset < g.stops[i - 1].offset))
            c.addIssue({ code: 'custom', message: 'Gradient stops must be ordered' });
    for (const s of v.shapes)
        for (const p of [s.fill, s.stroke])
            if (p.startsWith('url(') && !ids.has(p.slice(5, -1)))
                c.addIssue({ code: 'custom', message: 'Unknown gradient reference' });
});
/** A bounded drawing vocabulary. No XML, images, fonts, filters, URLs or execution from the model. */
export function vectorSceneSvg(input) {
    const v = vectorSceneSchema.parse(input);
    const gradients = v.gradients.map(g => `<linearGradient id="${g.id}" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}" color-interpolation="linearRGB">${g.stops.map(s => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join('')}</linearGradient>`).join('');
    const shapes = v.shapes.map(s => {
        const style = `fill="${s.fill}" stroke="${s.stroke}" stroke-width="${s.strokeWidth}" opacity="${s.opacity}" stroke-linejoin="round" stroke-linecap="round"`;
        if (s.type === 'path')
            return `<path d="${s.d}" ${style}/>`;
        if (s.type === 'rect')
            return `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.radius}" ${style}/>`;
        return `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}" ${style}/>`;
    }).join('');
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="650" viewBox="0 0 1000 650"><defs>${gradients}</defs>${shapes}</svg>`);
}
