/** Conservative owner-intent shortcut. Never applied to quotes, source pages,
 * forwarded content or commands; ambiguous messages stay with the executor. */
export function asksForSocialCreation(text:string):boolean {
  if(text.length>4000||/^\s*[/>{]/.test(text)||/\b(?:don[’']t|do not|never|not yet)\s+(?:\w+\s+){0,2}(?:create|generate|make|write|draft|post)\b/i.test(text))return false;
  if(/\b(?:endpoint|http|request body|database|blog|wordpress|postman|commit|pull request)\b/i.test(text))return false;
  return /\b(?:create|creat|generate|genrate|make|draft|write|design)\b[^.\n]{0,90}\b(?:posts?|carousels?|social (?:content|media)|instagram|linkedin|tiktok|threads)\b/i.test(text)
    || /\bpost\s+(?:on|for)\s+(?:linkedin|instagram|facebook|threads|reddit|x|twitter)\b/i.test(text);
}
