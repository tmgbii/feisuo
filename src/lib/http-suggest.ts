export const HTTP_HEADER_NAMES = [
  "Accept",
  "Accept-Encoding",
  "Accept-Language",
  "Authorization",
  "Cache-Control",
  "Connection",
  "Content-Type",
  "Cookie",
  "Host",
  "If-Modified-Since",
  "If-None-Match",
  "Origin",
  "Pragma",
  "Referer",
  "User-Agent",
  "X-API-Key",
  "X-Requested-With",
];

export const HTTP_CONTENT_TYPES = [
  "application/json",
  "application/xml",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
  "text/html",
  "text/csv",
  "application/octet-stream",
];

export const HTTP_ACCEPTS = [
  "*/*",
  "application/json",
  "application/xml",
  "text/plain",
  "text/html",
];

export function headerValueOptions(key: string): string[] {
  const name = key.trim().toLowerCase();
  if (name === "content-type") return HTTP_CONTENT_TYPES;
  if (name === "accept") return HTTP_ACCEPTS;
  if (name === "cache-control") return ["no-cache", "no-store", "max-age=0"];
  if (name === "connection") return ["keep-alive", "close"];
  return [];
}
