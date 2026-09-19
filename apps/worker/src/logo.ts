import logoPng from "./assets/logo.png";

export function logoResponse(): Response {
  return new Response(logoPng, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=604800",
    },
  });
}
