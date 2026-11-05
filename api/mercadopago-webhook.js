const crypto = require('crypto');

function response(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function header(headers, name) {
  const wanted = name.toLowerCase();
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === wanted)?.[1] || '';
}

function paymentId(event, body) {
  const query = event.queryStringParameters || {};
  return String(query['data.id'] || query.data_id || body?.data?.id || '');
}

function validSignature(event, body, secret) {
  const signature = header(event.headers, 'x-signature');
  const requestId = header(event.headers, 'x-request-id');
  const id = paymentId(event, body);
  if (!signature || !requestId || !id || !secret) return false;
  const parts = Object.fromEntries(signature.split(',').map(part => part.split('=').map(value => value.trim())));
  if (!parts.ts || !parts.v1) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(`id:${id};request-id:${requestId};ts:${parts.ts};`)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function supabaseHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY.');
  const headers = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function updateOrder(externalReference, changes) {
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('Falta SUPABASE_URL.');
  return fetch(`${base.replace(/\/$/, '')}/rest/v1/orders?external_reference=eq.${encodeURIComponent(externalReference)}`, {
    method: 'PATCH',
    headers: supabaseHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(changes)
  });
}

function planAccess(plan) {
  const normalized = String(plan || '').trim().toLowerCase();
  if (normalized === 'basic' || normalized === 'personal') return { plan: 'basic', rol: 'cliente_basic' };
  if (normalized === 'pro' || normalized === 'empresa') return { plan: 'pro', rol: 'cliente_pro' };
  if (normalized === 'business') return { plan: 'business', rol: 'empresa_admin' };
  throw new Error(`Plan no reconocido: ${normalized || 'vacío'}`);
}

function slugify(value) {
  return String(value || 'presentar')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'presentar';
}

function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let password = 'PrAR!';
  for (let index = 0; index < 14; index += 1) password += alphabet[crypto.randomInt(0, alphabet.length)];
  return password;
}

async function supabaseRest(path, options = {}) {
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('Falta SUPABASE_URL.');
  return fetch(`${base.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...options,
    headers: supabaseHeaders(options.headers || {})
  });
}

async function authAdmin(path, options = {}) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('Falta configuración de Supabase Auth.');
  const headers = { apikey: key, 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return fetch(`${base.replace(/\/$/, '')}/auth/v1/admin/${path}`, {
    ...options,
    headers
  });
}

async function readJson(response) {
  return response.json().catch(() => null);
}

async function findOrder(externalReference) {
  const response = await supabaseRest(`orders?external_reference=eq.${encodeURIComponent(externalReference)}&select=*&limit=1`);
  const rows = await readJson(response);
  if (!response.ok) throw new Error('No se pudo consultar el pedido.');
  return rows?.[0] || null;
}

async function findAuthUser(email) {
  const response = await authAdmin('users?page=1&per_page=1000');
  const data = await readJson(response);
  if (!response.ok) throw new Error('No se pudo consultar Supabase Auth.');
  return (data?.users || []).find(user => String(user.email || '').toLowerCase() === email) || null;
}

async function uniqueSlug(name, orderId) {
  const base = slugify(name);
  const candidates = [base, `${base}-${String(orderId).slice(0, 6)}`, `${base}-${crypto.randomBytes(3).toString('hex')}`];
  for (const slug of candidates) {
    const response = await supabaseRest(`tarjetas?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`);
    const rows = await readJson(response);
    if (!response.ok) throw new Error('No se pudo validar el slug.');
    if (!rows?.length) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}

async function provisionPlan(order, forcedPlan = null) {
  const email = String(order.email || '').trim().toLowerCase();
  const access = planAccess(forcedPlan || order.plan);
  if (!email) throw new Error('El pedido aprobado no tiene email.');

  let authUser = await findAuthUser(email);
  let createdAuthUser = false;
  if (authUser) {
    const response = await authAdmin(`users/${encodeURIComponent(authUser.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ app_metadata: { ...(authUser.app_metadata || {}), plan: access.plan, rol: access.rol } })
    });
    authUser = await readJson(response);
    if (!response.ok) throw new Error('No se pudo actualizar el plan en Supabase Auth.');
  } else {
    const password = temporaryPassword();
    const response = await authAdmin('users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        app_metadata: { plan: access.plan, rol: access.rol },
        user_metadata: {
          nombre: order.full_name || order.buyer_first_name || email.split('@')[0],
          empresa: order.company_name || '',
          slug: slugify(order.full_name || email.split('@')[0])
        }
      })
    });
    authUser = await readJson(response);
    if (!response.ok || !authUser?.id) throw new Error('No se pudo crear el acceso en Supabase Auth.');
    createdAuthUser = true;

    const base = process.env.SUPABASE_URL.replace(/\/$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const recoveryHeaders = { apikey: key, 'Content-Type': 'application/json' };
    if (!key.startsWith('sb_secret_')) recoveryHeaders.Authorization = `Bearer ${key}`;
    const recovery = await fetch(`${base}/auth/v1/recover?redirect_to=${encodeURIComponent('https://app.presentarstudio.com/login.html')}`, {
      method: 'POST',
      headers: recoveryHeaders,
      body: JSON.stringify({ email })
    });
    if (!recovery.ok) console.error('PRESENTAR_RECOVERY_EMAIL_ERROR', await recovery.text());
  }

  const userLookup = await supabaseRest(`usuarios?email=eq.${encodeURIComponent(email)}&select=id&limit=1`);
  const publicUsers = await readJson(userLookup);
  if (!userLookup.ok) throw new Error('No se pudo consultar el perfil del cliente.');

  let publicUserId = publicUsers?.[0]?.id || null;
  const userPayload = {
    email,
    password: 'SUPABASE_AUTH',
    nombre: order.full_name || order.buyer_first_name || email.split('@')[0],
    empresa: order.company_name || '',
    rol: access.rol,
    activo: true
  };
  if (publicUserId) {
    const update = await supabaseRest(`usuarios?id=eq.${encodeURIComponent(publicUserId)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ rol: access.rol })
    });
    if (!update.ok) throw new Error('No se pudo actualizar el perfil del plan.');
  } else {
    publicUserId = authUser.id;
    const create = await supabaseRest('usuarios', {
      method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ id: publicUserId, ...userPayload })
    });
    if (!create.ok) throw new Error('No se pudo crear el perfil del cliente.');
  }

  const cardLookup = await supabaseRest(`tarjetas?usuario_id=eq.${encodeURIComponent(publicUserId)}&select=id,slug,plan&limit=1`);
  const cards = await readJson(cardLookup);
  if (!cardLookup.ok) throw new Error('No se pudo consultar la tarjeta del cliente.');
  if (cards?.length) {
    const updateCardPlan = await supabaseRest(`tarjetas?id=eq.${encodeURIComponent(cards[0].id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ plan: access.plan })
    });
    if (!updateCardPlan.ok) throw new Error('No se pudo actualizar el plan de la tarjeta.');
  } else {
    const slug = await uniqueSlug(order.full_name || order.company_name || email.split('@')[0], order.id);
    const createCard = await supabaseRest('tarjetas', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        usuario_id: publicUserId,
        slug,
        nombre: order.full_name || order.buyer_first_name || email.split('@')[0],
        cargo: order.role || order.company_role || '',
        empresa: order.company_name || '',
        telefono: order.phone || '',
        email,
        plan: access.plan,
        activa: true
      })
    });
    if (!createCard.ok) throw new Error('No se pudo crear la tarjeta del cliente.');
  }

  return { plan: access.plan, rol: access.rol, created_auth_user: createdAuthUser };
}

const handleEvent = async (event) => {
  if (event.httpMethod !== 'POST') return response(405, { error: 'Método no permitido.' });
  const accessToken = process.env.MP_ACCESS_TOKEN;
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!accessToken || !secret) return response(500, { error: 'Faltan variables de entorno.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return response(400, { error: 'JSON inválido.' }); }

  if (!validSignature(event, body, secret)) return response(401, { error: 'Firma inválida.' });
  const type = body.type || body.topic || '';
  const id = paymentId(event, body);
  if (!id) return response(200, { received: true, ignored: true });

  try {
    if (type === 'subscription_preapproval') {
      const subscriptionResponse = await fetch(
        `https://api.mercadopago.com/preapproval/${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const subscription = await subscriptionResponse.json().catch(() => ({}));
      if (!subscriptionResponse.ok) {
        console.error('MERCADOPAGO_SUBSCRIPTION_LOOKUP_ERROR', subscription);
        return response(502, { error: 'No se pudo verificar el abono.' });
      }

      const subscriptionReference = String(subscription.external_reference || '');
      const externalReference = subscriptionReference.replace(/-PRO$/, '');
      if (!externalReference) return response(200, { received: true, ignored: true });
      const order = await findOrder(externalReference);
      if (!order) return response(200, { received: true, ignored: true, reason: 'pedido_no_encontrado' });

      const update = await supabaseRest(
        `orders?id=eq.${encodeURIComponent(order.id)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            mp_subscription_id: subscription.id,
            subscription_status: subscription.status || 'unknown',
            updated_at: new Date().toISOString()
          })
        }
      );
      if (!update.ok) {
        console.error('SUBSCRIPTION_STATUS_UPDATE_ERROR', await update.text());
        return response(500, { error: 'No se pudo actualizar el estado del abono.' });
      }

      let access = null;
      if (subscription.status === 'authorized') access = await provisionPlan(order, 'pro');
      if (subscription.status === 'paused' || subscription.status === 'cancelled') {
        access = await provisionPlan(order, 'basic');
      }
      return response(200, {
        received: true,
        verified: true,
        subscription_status: subscription.status,
        access
      });
    }

    if (type !== 'payment') return response(200, { received: true, ignored: true });

    const paymentResponse = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const payment = await paymentResponse.json().catch(() => ({}));
    if (!paymentResponse.ok) {
      console.error('MERCADOPAGO_PAYMENT_ERROR', payment);
      return response(502, { error: 'No se pudo verificar el pago.' });
    }

    const rawReference = String(payment.external_reference || '');
    const isSubscriptionPayment = rawReference.endsWith('-PRO');
    const externalReference = isSubscriptionPayment ? rawReference.replace(/-PRO$/, '') : rawReference;
    if (!externalReference) return response(200, { received: true, ignored: true });
    const order = await findOrder(externalReference);
    if (!order) return response(200, { received: true, ignored: true, reason: 'pedido_no_encontrado' });
    const changes = isSubscriptionPayment
      ? { subscription_status: payment.status === 'approved' ? 'authorized' : payment.status || 'unknown', updated_at: new Date().toISOString() }
      : { payment_status: payment.status || 'unknown', updated_at: new Date().toISOString() };
    const update = await updateOrder(externalReference, changes);
    if (!update.ok) {
      console.error('SUPABASE_ORDER_UPDATE_ERROR', await update.text());
      return response(500, { error: 'No se pudo actualizar el pedido.' });
    }
    let access = null;
    if (payment.status === 'approved' && isSubscriptionPayment) access = await provisionPlan(order, 'pro');
    if (payment.status === 'approved' && !isSubscriptionPayment && String(order.plan).toLowerCase() === 'basic') {
      access = await provisionPlan(order, 'basic');
    }
    return response(200, { received: true, verified: true, status: payment.status, access });
  } catch (error) {
    console.error('WEBHOOK_ERROR', error);
    return response(500, { error: 'Error interno.' });
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
