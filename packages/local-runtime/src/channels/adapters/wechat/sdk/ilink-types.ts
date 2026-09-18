/**
 * iLink Bot SDK — Protocol type definitions.
 *
 * Mirrors the Weixin iLink Bot API protobuf types (JSON transport).
 * All byte fields are base64-encoded strings in JSON.
 */

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

/** Common request metadata attached to every CGI request. */
export interface BaseInfo {
  channel_version?: string;
  bot_agent?: string;
}

// ---------------------------------------------------------------------------
// Upload media types
// ---------------------------------------------------------------------------

export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

export type UploadMediaTypeValue = (typeof UploadMediaType)[keyof typeof UploadMediaType];

// ---------------------------------------------------------------------------
// Message enums
// ---------------------------------------------------------------------------

export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

// ---------------------------------------------------------------------------
// Message item types
// ---------------------------------------------------------------------------

export interface TextItem {
  text?: string;
}

/** CDN media reference; aes_key is base64-encoded bytes in JSON. */
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  /** 0=only encrypt fileid, 1=packed thumbnail/mid-size info */
  encrypt_type?: number;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  /** Raw AES-128 key as hex string (16 bytes); preferred over media.aes_key for inbound decryption. */
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface VoiceItem {
  media?: CDNMedia;
  /** Voice encoding: 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  /** Voice duration in milliseconds */
  playtime?: number;
  /** Voice-to-text content */
  text?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}

// ---------------------------------------------------------------------------
// WeixinMessage — the unified inbound/outbound message
// ---------------------------------------------------------------------------

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  /** Must be echoed back in replies. */
  context_token?: string;
}

// ---------------------------------------------------------------------------
// GetUpdates
// ---------------------------------------------------------------------------

export interface GetUpdatesReq {
  /** Full context buf cached locally; send "" on first request. */
  get_updates_buf?: string;
  base_info?: BaseInfo;
}

export interface GetUpdatesResp {
  ret?: number;
  /** Error code (e.g. -14 = session timeout). */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** Full context buf to cache and send on next request. */
  get_updates_buf?: string;
  /** Server-suggested timeout (ms) for the next long-poll. */
  longpolling_timeout_ms?: number;
}

// ---------------------------------------------------------------------------
// SendMessage
// ---------------------------------------------------------------------------

export interface SendMessageReq {
  msg?: WeixinMessage;
  base_info?: BaseInfo;
}

// ---------------------------------------------------------------------------
// GetUploadUrl
// ---------------------------------------------------------------------------

export interface GetUploadUrlReq {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  rawsize?: number;
  rawfilemd5?: string;
  filesize?: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
  base_info?: BaseInfo;
}

export interface GetUploadUrlResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upload_full_url?: string;
  upload_param?: string;
  thumb_upload_param?: string;
}

// ---------------------------------------------------------------------------
// SendTyping
// ---------------------------------------------------------------------------

export interface SendTypingReq {
  ilink_user_id?: string;
  typing_ticket?: string;
  /** 1=typing, 2=cancel */
  status?: number;
  base_info?: BaseInfo;
}

export interface SendTypingResp {
  ret?: number;
  errmsg?: string;
}

// ---------------------------------------------------------------------------
// GetConfig
// ---------------------------------------------------------------------------

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

// ---------------------------------------------------------------------------
// QR Code Auth
// ---------------------------------------------------------------------------

export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface StatusResponse {
  status:
    | 'wait'
    | 'scaned'
    | 'confirmed'
    | 'expired'
    | 'scaned_but_redirect'
    | 'need_verifycode'
    | 'verify_code_blocked'
    | 'binded_redirect';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
  errcode?: number;
  errmsg?: string;
}
