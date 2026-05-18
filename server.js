/**
 * GAIA Checkout Demo — Backend stub
 *
 * Routes:
 *   POST /api/create-session   → creates a Juspay order session, returns payment_links + order_id
 *   GET  /api/order-status/:id → fetches order status from Juspay
 *   GET  /return               → handles redirect from Juspay after payment, fetches status, renders status page
 *
 * Env vars (set on Render):
 *   JUSPAY_API_KEY            — Juspay API key (used as Basic Auth username, password empty)
 *   JUSPAY_MERCHANT_ID        — value for x-merchantid header
 *   JUSPAY_CLIENT_ID          — payment_page_client_id (default: picasso)
 *   JUSPAY_BASE_URL           — sandbox: https://sandbox.juspay.in (default), prod: https://api.juspay.in
 *   PUBLIC_BASE_URL           — fully-qualified URL where this app is hosted (used for return_url)
 *   PORT                      — Render sets this automatically
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ----- Config -----
const JUSPAY_BASE_URL = process.env.JUSPAY_BASE_URL || 'https://sandbox.juspay.in';

// API key precedence: JUSPAY_API_KEY env var → ./apiKey.txt → empty.
// Frontend never sends the key; the backend reads it here only.
function loadApiKey() {
  if (process.env.JUSPAY_API_KEY) return process.env.JUSPAY_API_KEY.trim();
  try {
    const p = path.join(__dirname, 'apiKey.txt');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch {}
  return '';
}
const JUSPAY_API_KEY = loadApiKey();
const JUSPAY_MERCHANT_ID = process.env.JUSPAY_MERCHANT_ID || 'testamit333';
const JUSPAY_CLIENT_ID = process.env.JUSPAY_CLIENT_ID || 'testamit333';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// Build Basic auth header: base64("apiKey:")
function authHeader(apiKey) {
  return 'Basic ' + Buffer.from((apiKey || JUSPAY_API_KEY) + ':').toString('base64');
}

// Generate a short alphanumeric order id (Juspay max length 21)
function generateOrderId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `gaia_${ts}_${rand}`.slice(0, 21);
}

// Currency-Based Payment Filtering 
const CURRENCY_PM_MAP = {
  'EUR': [
    { type: 'NB', methods: ['NB_IDEAL', 'NB_BANCONTACT', 'NB_TRUSTLY'] },
    { type: 'WALLET', methods: ['ALIPAY', 'MBWAY', 'SATISPAY', 'WERO'] }
  ],
  'PLN': [
    { type: 'WALLET', methods: ['BLIK'] }
  ],
  'DKK': [
    { type: 'NB', methods: ['NB_TRUSTLY'] }
  ],
  'GBP': [
    { type: 'NB', methods: ['NB_TRUSTLY'] },
    { type: 'WALLET', methods: ['ALIPAY'] }
  ],
  'NOK': [
    { type: 'NB', methods: ['NB_TRUSTLY'] }
  ],
  'SEK': [
    { type: 'NB', methods: ['NB_TRUSTLY'] }
  ],
  'AUD': [{ type: 'WALLET', methods: ['ALIPAY'] }],
  'CAD': [{ type: 'WALLET', methods: ['ALIPAY'] }],
  'CHF': [{ type: 'WALLET', methods: ['ALIPAY'] }],
  'CNY': [{ type: 'WALLET', methods: ['ALIPAY'] }],
  'HKD': [{ type: 'WALLET', methods: ['ALIPAY'] }],
  'JPY': [{ type: 'WALLET', methods: ['ALIPAY'] }],
  'NZD': [{ type: 'WALLET', methods: ['ALIPAY'] }],
  'SGD': [{ type: 'WALLET', methods: ['ALIPAY'] }],
  'USD': [{ type: 'WALLET', methods: ['ALIPAY'] }]
};

function buildPaymentFilter(currency) {
  const upperCurrency = (currency || '').toUpperCase();
  const mapping = CURRENCY_PM_MAP[upperCurrency];

  if (!mapping) {
    return {
      allowDefaultOptions: false,
      options: [
        { paymentMethodType: 'NB', enable: false },
        { paymentMethodType: 'WALLET', enable: false }
      ]
    };
  }

  const options = mapping.map(item => ({
    paymentMethodType: item.type,
    paymentMethods: item.methods,
    enable: true
  }));

  return {
    allowDefaultOptions: false,  
    options
  };
}

// ----- POST /api/create-session -----
app.post('/api/create-session', async (req, res) => {
  try {
    const {
      amount,
      currency = 'GBP',
      first_name = 'John',
      last_name = 'Wick',
      customer_id = 'gaia_demo_customer',
      customer_email = 'demo@gaia.example',
      customer_phone = '8460767724',
      country_code = 'GBR',
      description = 'GAIA demo payment',
      gateway_reference_id = 'gaia_ppro',
      payment_page_client_id,
    } = req.body || {};

    const apiKey = JUSPAY_API_KEY;
    const clientId = req.headers['x-juspay-client-id'] || payment_page_client_id || JUSPAY_CLIENT_ID;

    if (!amount || isNaN(parseFloat(amount))) {
      return res.status(400).json({ error: 'amount is required and must be numeric' });
    }

    const order_id = generateOrderId();
    const return_url = `${PUBLIC_BASE_URL}/return`;

    const payment_filter = buildPaymentFilter(currency);

    const payload = {
      order_id,
      amount: parseFloat(amount).toFixed(2),
      first_name,
      last_name,
      customer_id,
      customer_email,
      customer_phone,
      billing_address_country_code_iso: country_code,
      action: 'paymentPage',
      currency,
      description,
      payment_page_client_id: clientId,
      return_url,
      'metadata.JUSPAY:gateway_reference_id': gateway_reference_id,
      payment_filter, 
    };

    const headers = {
      'Content-Type': 'application/json',
      'version': '2021-06-01',
      'Authorization': authHeader(apiKey),
      'x-merchantid': JUSPAY_MERCHANT_ID,
      'x-routing-id': customer_id,
    };

    console.log('[create-session] →', JUSPAY_BASE_URL + '/session', { order_id, amount, currency });

    const upstream = await fetch(`${JUSPAY_BASE_URL}/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!upstream.ok) {
      console.error('[create-session] Juspay error', upstream.status, data);
      return res.status(upstream.status).json({
        error: 'juspay_error',
        status: upstream.status,
        details: data,
        request_payload: payload,
      });
    }

    console.log('[create-session] ✓', { order_id, status: data.status, link: data.payment_links?.web });

    return res.json({
      ok: true,
      order_id,
      juspay_status: data.status,
      payment_links: data.payment_links,
      sdk_payload: data.sdk_payload,
      request_payload: payload,
      raw_response: data,
    });
  } catch (err) {
    console.error('[create-session] exception', err);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ----- GET /api/order-status/:order_id -----
app.get('/api/order-status/:order_id', async (req, res) => {
  try {
    const { order_id } = req.params;
    const apiKey = JUSPAY_API_KEY;
    const headers = {
      'version': '2021-06-01',
      'Authorization': authHeader(apiKey),
      'x-merchantid': JUSPAY_MERCHANT_ID,
      'x-routing-id': order_id,
    };

    const upstream = await fetch(`${JUSPAY_BASE_URL}/orders/${encodeURIComponent(order_id)}`, {
      method: 'GET',
      headers,
    });

    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'juspay_error', details: data });
    }

    // Map Juspay status to a simple bucket the UI can render
    const status = (data.status || '').toUpperCase();
    let bucket = 'pending';
    if (['CHARGED', 'COD_INITIATED', 'AUTO_REFUNDED', 'PARTIALLY_CHARGED'].includes(status)) bucket = 'success';
    else if (['AUTHORIZATION_FAILED', 'AUTHENTICATION_FAILED', 'JUSPAY_DECLINED', 'TERMINAL_FAILURE'].includes(status)) bucket = 'failure';
    else if (['DECLINED', 'VOIDED', 'EXPIRED', 'NOT_FOUND'].includes(status)) bucket = 'failure';
    else if (['NEW', 'PENDING_VBV', 'AUTHORIZING', 'STARTED'].includes(status)) bucket = 'pending';

    return res.json({
      ok: true,
      order_id,
      status,
      bucket,
      amount: data.amount,
      currency: data.currency,
      payment_method: data.payment_method,
      payment_method_type: data.payment_method_type,
      txn_uuid: data.txn_uuid,
      raw: data,
    });
  } catch (err) {
    console.error('[order-status] exception', err);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ----- GET /return -----
// Juspay redirects the customer here after payment completion.
// We render a status page that polls /api/order-status to confirm the result.
app.get('/return', (req, res) => {
  // Juspay typically appends order_id and status as query params
  const order_id = req.query.order_id || req.query.orderId || '';
  res.sendFile(path.join(__dirname, 'public', 'status.html'));
});

// ----- POST /api/fulfill-order -----
// Stub for post-payment fulfillment (e.g. issue ticket, update inventory).
// In a real integration this would call the merchant's PNR / order system.
app.post('/api/fulfill-order', async (req, res) => {
  try {
    const { order_id, pnr } = req.body || {};
    if (!order_id) return res.status(400).json({ error: 'order_id required' });

    console.log('[fulfill-order]', { order_id, pnr });

    // Stub: mark fulfilled (replace with real downstream call)
    return res.json({
      ok: true,
      order_id,
      pnr: pnr || `GAIA${Math.random().toString(36).slice(2,8).toUpperCase()}`,
      fulfilled_at: new Date().toISOString(),
      status: 'FULFILLED',
    });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// Health check (Render uses this)
app.get('/healthz', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GAIA checkout demo listening on :${PORT}`);
  console.log(`Juspay: ${JUSPAY_BASE_URL}, merchant: ${JUSPAY_MERCHANT_ID}, public: ${PUBLIC_BASE_URL}`);
});
