function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function clean(value, max = 300) {
  return String(value ?? '').trim().slice(0, max);
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

const handleEvent = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Método no permitido.' });
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return json(500, { error: 'Falta configurar Mercado Pago.' });

  let orderId = null;
  try {
    const body = JSON.parse(event.body || '{}');
    const requestedPlan = clean(body.plan, 30).toLowerCase();
    const planAliases = { personal: 'Basic', basic: 'Basic', empresa: 'Pro', pro: 'Pro' };
    const plan = planAliases[requestedPlan];
    if (!plan) return json(400, { error: 'El plan seleccionado no admite compra directa.' });
    const planDb = plan.toLowerCase();
    const quantity = Math.max(1, Number(body.cantidad || 1));
    const email = clean(body.email, 320).toLowerCase();
    const basePrices = { Basic: 49900, Pro: 59900 };
    const discounts = { 1: 0, 5: 7, 10: 14, 25: 20 };

    if (!email || !email.includes('@')) return json(400, { error: 'Email inválido.' });
    if (![1, 5, 10, 25].includes(quantity)) return json(400, { error: 'Cantidad inválida.' });

    const unitPrice = Math.round(basePrices[plan] * (1 - (discounts[quantity] || 0) / 100));
    const total = unitPrice * quantity;
    const externalReference = `PRESENTAR-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const fullName = clean(body.full_name, 160) || clean(`${body.buyer_first_name || ''} ${body.buyer_last_name || ''}`, 160);
    if (!fullName) return json(400, { error: 'Falta el nombre para la tarjeta.' });

    const order = {
      external_reference: externalReference,
      email,
      plan: planDb,
      model_id: clean(body.model_id, 80) || 'Modelo 01',
      full_name: fullName,
      role: clean(body.role, 160) || null,
      company_name: clean(body.company_name, 160) || null,
      company_area: clean(body.company_area, 160) || null,
      company_role: clean(body.company_role, 160) || null,
      quantity,
      unit_price: unitPrice,
      total_amount: total,
      payment_status: 'pending',
      buyer_first_name: clean(body.buyer_first_name, 100) || null,
      buyer_last_name: clean(body.buyer_last_name, 100) || null,
      phone: clean(body.phone, 60) || null,
      address: clean(body.address, 220) || null,
      city: clean(body.city, 120) || null,
      province: clean(body.province, 120) || null,
      postal_code: clean(body.postal_code, 30) || null,
      dni_cuit: clean(body.dni_cuit, 40) || null
    };

    const insert = await supabaseRequest('orders', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(order)
    });
    const inserted = await insert.json().catch(() => null);
    if (!insert.ok || !inserted?.[0]?.id) {
      console.error('SUPABASE_ORDER_INSERT_ERROR', inserted || { status: insert.status });
      return json(500, { error: 'No pudimos registrar el pedido.' });
    }
    orderId = inserted[0].id;

    const appBaseUrl = String(process.env.APP_BASE_URL || 'https://app.presentarstudio.com').replace(/\/$/, '');
    const preference = {
      items: [{
        id: `presentar-${planDb}`,
        title: `PresentAR ${plan}`,
        description: `${quantity} tarjeta(s) PresentAR ${plan}`,
        quantity,
        currency_id: 'ARS',
        unit_price: unitPrice
      }],
      payer: { email },
      external_reference: externalReference,
      back_urls: {
        success: `${appBaseUrl}/compra-exitosa.html?plan=${planDb}`,
        failure: `${appBaseUrl}/compra-error.html?plan=${planDb}`,
        pending: `${appBaseUrl}/compra-pendiente.html?plan=${planDb}`
      },
      notification_url: `${appBaseUrl}/api/mercadopago-webhook`,
      auto_return: 'approved',
      statement_descriptor: 'PRESENTAR'
    };

    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(preference)
    });
    const data = await mpResponse.json().catch(() => ({}));
    if (!mpResponse.ok || !data.id) {
      console.error('MERCADOPAGO_PREFERENCE_ERROR', data);
      return json(502, { error: 'Mercado Pago rechazó la preferencia.' });
    }

    const update = await supabaseRequest(`orders?id=eq.${encodeURIComponent(orderId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ mp_preference_id: data.id, updated_at: new Date().toISOString() })
    });
    if (!update.ok) console.error('SUPABASE_PREFERENCE_UPDATE_ERROR', await update.text());

    return json(200, { id: data.id, init_point: data.init_point, external_reference: externalReference });
  } catch (error) {
    console.error('CHECKOUT_ERROR', error);
    return json(500, { error: 'No pudimos iniciar el pago.' });
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
