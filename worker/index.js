// Cloudflare Worker: serves site/ on its own origin and sends the old danielrivera.ai/tools address there,
// so no tool ever runs on the main site's origin.
export const HOST = 'tools.danielrivera.ai';

export function redirectFor(url) {
  if (url.hostname === HOST) return null;
  const path = url.pathname.replace(/^\/tools(?=\/|$)/, '') || '/';
  return `https://${HOST}${path}${url.search}`;
}

export default {
  async fetch(request, env) {
    const target = redirectFor(new URL(request.url));
    return target ? Response.redirect(target, 301) : env.ASSETS.fetch(request);
  },
};
