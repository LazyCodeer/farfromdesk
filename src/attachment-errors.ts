// Reasons an attachment was refused that are written for the owner and safe to show as they are.
// Anything else (a database or network error) stays behind the channel's generic message.
const SAFE=/^(?:Use a simple|Unsupported|Attachment |Files must|Text files|Binary data|Invalid (?:PDF|PNG|JPEG|WebP|GIF|ZIP|gzip|executable|WebAssembly|video)|Expected a complete|The intended session|Choose an exact session|That quoted message|Session is missing|Two attachments|Incoming attachment|[A-Za-z][\w .-]{0,40} mode accepts text|Your chosen session is paused|The selected session changed|Send schedules as|Send the task as a text|This attachment request already exists|Telegram bot downloads must be|Connection changed)/;

export function attachmentRefusal(e:unknown):string|undefined {
  const message=e instanceof Error?e.message:'';
  return message&&message.length<=400&&SAFE.test(message)?message:undefined;
}
