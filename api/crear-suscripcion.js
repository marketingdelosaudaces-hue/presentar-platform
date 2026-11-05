function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function privateHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY.');
  const headers = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function supabaseRequest(path, options = {}) {
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('Falta SUPABASE_URL.');
  return fetch(`${base.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...options,
    headers: privateHeaders(options.headers || {})
  });
}

async function readJson(response) {
  return response.json().catch(() => null);
}

const handleEvent = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido.' });

  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) return json(500, { error: 'Falta configurar Mercado Pago.' });

  try {
    const body = JSON.parse(event.body || '{}');
    const externalReference = String(body.external_reference || '').trim().slice(0, 120);
    const paymentId = String(body.payment_id || '').trim().slice(0, 80);
    const requestedEmail = String(body.email || '').trim().toLowerCase().slice(0, 320);
    if (!externalReference || !paymentId) return json(400, { error: 'Falta verificar la compra.' });

    const paymentResponse = await fetch(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const payment = await readJson(paymentResponse);
    if (!paymentResponse.ok || String(payment.status).toLowerCase() !== 'approved') {
      return json(403, { error: 'El pago todavía no fue aprobado por Mercado Pago.' });
    }
    if (String(payment.external_reference || '') !== externalReference) {
      return json(403, { error: 'La referencia del pago no coincide.' });
    }

    const orderResponse = await supabaseRequest(
      `orders?external_reference=eq.${encodeURIComponent(externalReference)}&select=*&limit=1`
    );
    const orders = await readJson(orderResponse);
    const order = orders?.[0];
    if (!orderResponse.ok || !order) return json(404, { error: 'No encontramos la compra.' });
    if (String(order.payment_status).toLowerCase() !== 'approved') {
      return json(409, { error: 'El pago de la tarjeta todavía no está aprobado.' });
    }
    if (String(order.plan).toLowerCase() !== 'pro') {
      return json(400, { error: 'Esta compra no necesita un abono Pro.' });
    }
    if (requestedEmail && requestedEmail !== String(order.email || '').toLowerCase()) {
      return json(403, { error: 'Los datos de la compra no coinciden.' });
    }
    const paymentEmail = String(payment.payer?.email || '').trim().toLowerCase();
    if (paymentEmail && paymentEmail !== String(order.email || '').toLowerCase()) {
      return json(403, { error: 'El titular del pago no coincide con el pedido.' });
    }

    if (order.mp_subscription_id && order.subscription_status !== 'cancelled') {
      const existingResponse = await fetch(
        `https://api.mercadopago.com/preapproval/${encodeURIComponent(order.mp_subscription_id)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const existing = await readJson(existingResponse);
      if (existingResponse.ok && existing?.init_point) {
        return json(200, {
          id: existing.id,
          init_point: existing.init_point,
          status: existing.status,
          reused: true
        });
      }
    }

    const appBaseUrl = String(process.env.APP_BASE_URL || 'https://app.presentarstudio.com').replace(/\/$/, '');
    const monthlyAmount = Number(process.env.MP_PRO_MONTHLY_AMOUNT || 12900);
    if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) {
      throw new Error('El importe mensual configurado no es válido.');
    }

    const subscriptionPayload = {
      reason: 'Abono mensual PresentAR Pro',
      external_reference: `${externalReference}-PRO`,
      payer_email: order.email,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: monthlyAmount,
        currency_id: 'ARS'
      },
      back_url: `${appBaseUrl}/compra-exitosa.html?plan=pro&subscription=1&order=${encodeURIComponent(externalReference)}`,
      status: 'pending'
    };

    const mpResponse = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(subscriptionPayload)
    });
    const subscription = await readJson(mpResponse);
    if (!mpResponse.ok || !subscription?.id || !subscription?.init_point) {
      console.error('MERCADOPAGO_SUBSCRIPTION_ERROR', subscription);
      return json(502, { error: 'Mercado Pago no pudo iniciar el abono.' });
    }

    const update = await supabaseRequest(
      `orders?id=eq.${encodeURIComponent(order.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          mp_subscription_id: subscription.id,
          subscription_status: subscription.status || 'pending',
          updated_at: new Date().toISOString()
        })
      }
    );
    if (!update.ok) console.error('SUBSCRIPTION_ORDER_UPDATE_ERROR', await update.text());

    return json(200, {
      id: subscription.id,
      init_point: subscription.init_point,
      status: subscription.status
    });
  } catch (error) {
    console.error('SUBSCRIPTION_CHECKOUT_ERROR', error);
    return json(500, { error: 'No pudimos iniciar el abono mensual.' });
  }
};

// Adaptador HTTP nativo de Vercel; no realiza operaciones de base de datos.
module.exports = async function vercelHandler(req, res) {
  const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  for (const [key, value] of Object.entries(req.query || {})) {
    query[key] = Array.isArray(value) ? value[0] : value;
  }
  const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8')
    : typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  const result = await handleEvent({
    httpMethod: req.method, headers: req.headers || {},
    queryStringParameters: query, body
  });
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(result.headers || {})) res.setHeader(name, value);
  res.status(result.statusCode).send(result.body);
};
