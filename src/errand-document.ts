import {generateWAMessageFromContent,prepareWAMessageMedia,type WAMediaUploadFunction} from '@whiskeysockets/baileys';
import {boundedDocumentUpload,DOCUMENT_UPLOAD_TIMEOUT_MS} from './document-delivery.js';
import type {GuardedSocket} from './wa-guard.js';

/** Prepare and upload a small encrypted document, then synchronously recheck before relay. */
export async function sendErrandDraftDocument(sock:GuardedSocket,destination:string,text:string,messageId:string,beforeRelay:()=>void,uploadOverride?:WAMediaUploadFunction){
  const data=Buffer.from(text,'utf8');if(!data.length||data.length>16000)throw new Error('The job draft is unavailable.');
  const signal=AbortSignal.timeout(60000);
  const media=await prepareWAMessageMedia({document:data,fileName:'job-draft.txt',mimetype:'text/plain',caption:'Job draft. Review the listing and fill in the blanks yourself.'},
    {upload:uploadOverride??boundedDocumentUpload(sock,signal),mediaUploadTimeoutMs:Math.min(DOCUMENT_UPLOAD_TIMEOUT_MS,60000)});
  signal.throwIfAborted();if(!sock.user?.id)throw new Error('WhatsApp disconnected before document delivery.');
  const message=generateWAMessageFromContent(destination,media,{userJid:sock.user.id,messageId});
  beforeRelay();signal.throwIfAborted();
  await sock.relayMessage(destination,message.message!,{messageId});return message;
}
