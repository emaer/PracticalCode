/**
 * Telegram Bot API reverse proxy on Cloudflare Workers.
 * Forwards method / headers / body (including multipart sendPhoto) to api.telegram.org.
 */

const Method = (method) => (req) => req.method.toLowerCase() === method.toLowerCase();
const Get = Method('get');
const Post = Method('post');

const Path = (regExp) => (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = path.match(regExp);
  return m && m[0] === path;
};

/** bot_token may contain ':'; api_method is camelCase e.g. sendPhoto */
const URL_PATH_REGEX = /^\/bot(?<bot_token>[^/]+)\/(?<api_method>[A-Za-z0-9]+)$/;

class Router {
  constructor() {
    this.routes = [];
  }

  handle(conditions, handler) {
    this.routes.push({ conditions, handler });
    return this;
  }

  get(url, handler) {
    return this.handle([Get, Path(url)], handler);
  }

  post(url, handler) {
    return this.handle([Post, Path(url)], handler);
  }

  route(req) {
    const route = this.resolve(req);
    if (route) {
      return route.handler(req);
    }

    const description = 'No matching route found';
    const error_code = 404;
    return new Response(JSON.stringify({ ok: false, error_code, description }), {
      status: error_code,
      statusText: description,
      headers: { 'content-type': 'application/json' },
    });
  }

  resolve(req) {
    return this.routes.find((r) => {
      if (!r.conditions || (Array.isArray(r.conditions) && !r.conditions.length)) {
        return true;
      }
      if (typeof r.conditions === 'function') {
        return r.conditions(req);
      }
      return r.conditions.every((c) => c(req));
    });
  }
}

function jsonError(error_code, description) {
  return new Response(JSON.stringify({ ok: false, error_code, description }), {
    status: error_code,
    statusText: description,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Forward the inbound request to Telegram Bot API.
 * Do NOT destructure/spread Request — that drops multipart body and Content-Type boundary.
 */
async function handler(request) {
  const incomingUrl = new URL(request.url);
  const matched = incomingUrl.pathname.match(URL_PATH_REGEX);
  if (!matched || !matched.groups) {
    return jsonError(400, 'Invalid bot API path');
  }

  const { bot_token, api_method } = matched.groups;
  const api_url =
    'https://api.telegram.org/bot' + bot_token + '/' + api_method + incomingUrl.search;

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ray');
  headers.delete('cf-visitor');
  headers.delete('cf-ipcountry');
  headers.delete('x-forwarded-proto');
  headers.delete('x-real-ip');

  const init = {
    method: request.method,
    headers,
    redirect: 'follow',
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }

  const response = await fetch(api_url, init);
  const result = await response.text();

  const outHeaders = new Headers();
  outHeaders.set('content-type', response.headers.get('content-type') || 'application/json');

  return new Response(result, {
    status: response.status,
    statusText: response.statusText,
    headers: outHeaders,
  });
}

async function handleRequest(request) {
  const r = new Router();
  r.get(URL_PATH_REGEX, (req) => handler(req));
  r.post(URL_PATH_REGEX, (req) => handler(req));
  return r.route(request);
}

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});
