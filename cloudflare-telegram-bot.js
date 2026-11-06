/**
 * Helper functions to check if the request uses
 * corresponding method.
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

/**
 * bot_token 含冒号；api_method 为 camelCase（sendPhoto / sendDocument 等）
 */
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
    return new Response(
      JSON.stringify({ ok: false, error_code, description }),
      {
        status: error_code,
        statusText: description,
        headers: { 'content-type': 'application/json' },
      }
    );
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
 * 把客户端请求原样转发到 api.telegram.org（含 multipart 文件上传）。
 * 不能对 Request 做对象解构/展开，否则 body 与 Content-Type(boundary) 会丢失。
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

  // 转发头：保留 multipart 的 content-type（含 boundary）
  const headers = new Headers(request.headers);
  headers.delete('host');
  // Cloudflare / 浏览器可能带的头，转给 Telegram 无意义
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
    // 流式转发 body，支持 sendPhoto / sendDocument 等 multipart
    init.body = request.body;
    // Workers 把 ReadableStream 作为 fetch body 时需要
    init.duplex = 'half';
  }

  const response = await fetch(api_url, init);
  const result = await response.text();

  const outHeaders = new Headers();
  const ct = response.headers.get('content-type') || 'application/json';
  outHeaders.set('content-type', ct);

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
