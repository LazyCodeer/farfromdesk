export type SocialImageProvider='local'|'meta';
/** Only explicit owner language changes a phone mode; mentions in source material do not. */
export function requestedSocialImageProvider(body:string):SocialImageProvider|undefined {
 if(/\b(?:use|using|with|via)\s+(?:the\s+)?(?:local|SVG)\b/i.test(body)||/\b(?:do not|don't|without|not|never)\b[^.\n]{0,80}\bMeta\b/i.test(body))return 'local';
 if(/\b(?:use|using|with|via)\s+(?:the\s+)?Meta\s+(?:API|image|for\s+(?:the\s+)?images?)\b/i.test(body))return 'meta';
}
